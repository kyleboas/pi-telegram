#!/usr/bin/env node
/**
 * pi-telegram-router: Parallel Telegram bridge for pi coding agent.
 *
 * Architecture:
 *   - One Node.js router process polls Telegram and manages worker lanes.
 *   - Each conversation lane is backed by a separate `pi --mode rpc` child process.
 *   - Messages are routed to workers by conversation lane key (anchor message ID).
 *   - /new spawns a new worker lane and returns an anchor message.
 *   - Replying to an anchor message routes to that lane's worker.
 *   - Multiple lanes process in true parallel.
 *
 * Usage:
 *   node /home/kyle/.local/bin/pi-telegram-router
 */

import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface TelegramUser { id: number; is_bot: boolean; first_name: string; username?: string }
interface TelegramChat { id: number; type: string }
interface TelegramPhotoSize { file_id: string; file_size?: number }
interface TelegramDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface TelegramVideo { file_id: string; file_name?: string; mime_type?: string }
interface TelegramAudio { file_id: string; file_name?: string; mime_type?: string }
interface TelegramVoice { file_id: string; mime_type?: string }
interface TelegramAnimation { file_id: string; file_name?: string; mime_type?: string }
interface TelegramSticker { file_id: string; emoji?: string }

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	reply_to_message?: TelegramMessage;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: unknown;
}

interface TelegramSentMessage { message_id: number }
interface TelegramGetFileResult { file_path: string }

interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

interface LaneInfo {
	laneKey: string;           // anchor message ID or "default"
	worker: PiWorker;
	createdAt: Date;
	label?: string;
}

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: Record<string, unknown>;
}

interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

interface MediaGroupState {
	messages: TelegramMessage[];
	timer?: ReturnType<typeof setTimeout>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram-parallel");
const REGISTRY_PATH = join(homedir(), ".pi", "agent", "telegram-lanes.json");
const DEBUG_LOG_PATH = join(homedir(), ".pi", "agent", "telegram-parallel-debug.log");
const MAX_MESSAGE_LENGTH = 4096;
const MEDIA_GROUP_DEBOUNCE_MS = 1200;
const POLL_TIMEOUT_SEC = 30;
const PI_BIN = "/usr/bin/pi";

// ─── Lane Registry (persistence) ────────────────────────────────────────────

interface LaneRegistry {
	lanes: Record<string, {
		anchorMessageId: number;
		sessionFile?: string;
		label?: string;
		createdAt: string;
	}>;
	lastUpdateId?: number;
}

// ─── Pi RPC Worker ──────────────────────────────────────────────────────────

class PiWorker {
	private proc: ChildProcess | null = null;
	private rl: ReturnType<typeof createInterface> | null = null;
	private pendingRequests = new Map<string, {
		resolve: (resp: RpcResponse) => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private eventListeners: ((event: RpcEvent) => void)[] = [];
	private seq = 0;
	private alive = false;
	private buffer = "";

	constructor(public readonly laneKey: string) {}

	async start(sessionFile?: string): Promise<void> {
		if (this.proc) return;
		const args = ["--mode", "rpc"];
		if (sessionFile) args.push("--session", sessionFile);
		await log(`worker(${this.laneKey}): spawning pi --mode rpc${sessionFile ? ` --session ${sessionFile}` : ""}`);
		this.proc = spawn(PI_BIN, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: homedir(),
			env: { ...process.env, HOME: homedir() },
		});
		this.alive = true;

		this.proc.stdout!.on("data", (chunk: Buffer) => {
			const raw = chunk.toString("utf8");
			this.buffer += raw;
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop()!;
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const obj = JSON.parse(trimmed);
					this.handleMessage(obj);
				} catch {
					void log(`worker(${this.laneKey}) non-JSON stdout: ${trimmed.slice(0, 120)}`);
				}
			}
		});

		this.proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) void log(`worker(${this.laneKey}) stderr: ${text.slice(0, 200)}`);
		});

		this.proc.on("exit", (code, signal) => {
			void log(`worker(${this.laneKey}): exited code=${code} signal=${signal}`);
			this.alive = false;
			this.proc = null;
			// reject all pending
			for (const [, p] of this.pendingRequests) {
				p.reject(new Error("Worker exited"));
				clearTimeout(p.timer);
			}
			this.pendingRequests.clear();
		});

		// Wait for it to be ready by sending get_state
		const state = await this.sendCommand("get_state", {});
		await log(`worker(${this.laneKey}): ready session=${state.data?.sessionFile ?? "none"}`);
	}

	sendCommand<T = Record<string, unknown>>(command: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<RpcResponse & { data?: T }> {
		return new Promise((resolve, reject) => {
			if (!this.proc || !this.alive) {
				reject(new Error(`Worker(${this.laneKey}) not alive`));
				return;
			}
			const id = `req-${++this.seq}`;
			const payload = JSON.stringify({ id, type: command, ...params });
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Worker(${this.laneKey}) timeout on ${command}`));
			}, timeoutMs);
			this.pendingRequests.set(id, { resolve: resolve as (r: RpcResponse) => void, reject, timer });
			this.proc.stdin!.write(payload + "\n");
		});
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	async stop(): Promise<void> {
		if (!this.proc) return;
		this.alive = false;
		this.proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.proc?.kill("SIGKILL");
				resolve();
			}, 5000);
			this.proc!.on("exit", () => { clearTimeout(timeout); resolve(); });
		});
		this.proc = null;
	}

	get isAlive(): boolean { return this.alive; }

	private handleMessage(obj: Record<string, unknown>): void {
		if (obj.type === "response" && obj.id) {
			const pending = this.pendingRequests.get(obj.id as string);
			if (pending) {
				this.pendingRequests.delete(obj.id as string);
				clearTimeout(pending.timer);
				pending.resolve(obj as RpcResponse);
			}
		} else {
			// Event
			for (const listener of this.eventListeners) {
				listener(obj as RpcEvent);
			}
		}
	}
}

// ─── Telegram API ───────────────────────────────────────────────────────────

let config: TelegramConfig = {};

async function callTelegram<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	if (!config.botToken) throw new Error("No bot token");
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			`https://api.telegram.org/bot${config.botToken}/${method}`,
			{
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
				timeout: 35000,
				...(signal ? { signal } : {}),
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TelegramApiResponse<T>;
						if (!parsed.ok) return reject(new Error(parsed.description ?? `Telegram API error: ${method}`));
						resolve(parsed.result as T);
					} catch (e) { reject(e); }
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => { req.destroy(); reject(new Error("Telegram API timeout")); });
		req.write(payload);
		req.end();
	});
}

async function sendMessage(chatId: number, text: string, replyTo?: number): Promise<TelegramSentMessage> {
	return callTelegram<TelegramSentMessage>("sendMessage", {
		chat_id: chatId,
		text,
		...(replyTo ? { reply_to_message_id: replyTo } : {}),
	});
}

async function sendChunkedReply(chatId: number, replyTo: number, text: string): Promise<number[]> {
	const chunks = chunkText(text);
	const ids: number[] = [];
	for (const chunk of chunks) {
		const sent = await sendMessage(chatId, chunk, replyTo);
		ids.push(sent.message_id);
	}
	return ids;
}

async function sendTyping(chatId: number): Promise<void> {
	await callTelegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

async function downloadFile(fileId: string, fileName: string): Promise<string> {
	await mkdir(TEMP_DIR, { recursive: true });
	const result = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
	if (!result.file_path) throw new Error("No file_path from Telegram");
	const url = `https://api.telegram.org/file/bot${config.botToken}/${result.file_path}`;
	const dest = join(TEMP_DIR, fileName);
	return new Promise((resolve, reject) => {
		httpsRequest(url, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", async () => {
				await writeFile(dest, Buffer.concat(chunks));
				resolve(dest);
			});
		}).on("error", reject).end();
	});
}

async function deleteWebhook(): Promise<void> {
	await callTelegram("deleteWebhook", { drop_pending_updates: false });
}

async function getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
	return callTelegram<TelegramUpdate[]>("getUpdates", {
		offset,
		timeout: POLL_TIMEOUT_SEC,
		allowed_updates: ["message", "edited_message", "callback_query"],
	}, signal);
}

// ─── Utility ────────────────────────────────────────────────────────────────

async function log(msg: string): Promise<void> {
	try {
		await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
		await appendFile(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
	} catch { /* ignore */ }
}

function chunkText(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
		chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
	}
	return chunks;
}

function parseCommand(rawText: string): { name: string; args: string } | undefined {
	const trimmed = rawText.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const spaceIdx = trimmed.search(/\s/);
	const token = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();
	const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i.exec(token);
	if (!match) return undefined;
	const [, name, mentioned] = match;
	if (mentioned && config.botUsername && mentioned.toLowerCase() !== config.botUsername.toLowerCase()) return undefined;
	return { name: name.toLowerCase(), args };
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

// ─── Lane Manager ───────────────────────────────────────────────────────────

const lanes = new Map<string, LaneInfo>();
const mediaGroups = new Map<string, MediaGroupState>();
const userLastLane = new Map<number, string>(); // chatId -> laneKey (set by /new, persists until next /new or reply to anchor)
const messageToLane = new Map<string, string>(); // sent message ID -> laneKey

async function loadRegistry(): Promise<LaneRegistry> {
	try {
		const data = await readFile(REGISTRY_PATH, "utf8");
		return JSON.parse(data) as LaneRegistry;
	} catch {
		return { lanes: {} };
	}
}

async function saveRegistry(registry: LaneRegistry): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, "\t") + "\n", "utf8");
}

async function getOrCreateLane(laneKey: string, chatId: number, replyToMessageId: number): Promise<LaneInfo> {
	const existing = lanes.get(laneKey);
	if (existing && existing.worker.isAlive) return existing;

	// Check registry for existing session file to resume
	const registry = await loadRegistry();
	const existingSession = registry.lanes[laneKey]?.sessionFile;

	await log(`Creating new worker lane: ${laneKey}${existingSession ? ` (resuming session ${existingSession})` : ""}`);
	const worker = new PiWorker(laneKey);
	await worker.start(existingSession);

	// Record session file
	const state = await worker.sendCommand("get_state", {});
	const sessionFile = state.data?.sessionFile as string | undefined;

	// Set up event listener to collect responses
	setupWorkerEvents(worker);

	const lane: LaneInfo = { laneKey, worker, createdAt: new Date() };
	lanes.set(laneKey, lane);

	// Persist
	if (laneKey !== "default") {
		registry.lanes[laneKey] = {
			anchorMessageId: parseInt(laneKey, 10),
			sessionFile,
			createdAt: new Date().toISOString(),
		};
	}
	await saveRegistry(registry);

	return lane;
}

async function createNewLane(chatId: number, replyToMessageId: number): Promise<{ lane: LaneInfo; anchorMessageId: number }> {
	// Create a new worker with a new session
	const worker = new PiWorker(`pending-${Date.now()}`);
	await worker.start();

	// Tell it to create a new session
	const newSessionResp = await worker.sendCommand("new_session", {});
	if (newSessionResp.data?.cancelled) {
		await worker.stop();
		throw new Error("Session creation cancelled");
	}

	// Get the new session file
	const state = await worker.sendCommand("get_state", {});
	const sessionFile = state.data?.sessionFile as string | undefined;

	// Send anchor message to Telegram
	const anchorMsg = await sendMessage(chatId, "New conversation started.\nReply to this message to continue this conversation.", replyToMessageId);
	const anchorId = anchorMsg.message_id;
	const laneKey = String(anchorId);

	// Update worker laneKey
	(worker as { laneKey: string }).laneKey = laneKey;

	// Set up events
	setupWorkerEvents(worker);

	const lane: LaneInfo = { laneKey, worker, createdAt: new Date(), label: `Lane ${anchorId}` };
	lanes.set(laneKey, lane);

	// Persist
	const registry = await loadRegistry();
	registry.lanes[laneKey] = {
		anchorMessageId: anchorId,
		sessionFile,
		createdAt: new Date().toISOString(),
	};
	await saveRegistry(registry);

	await log(`New lane created: ${laneKey} session=${sessionFile ?? "none"}`);
	return { lane, anchorMessageId: anchorId };
}

// Track pending prompt reply targets per worker
const workerReplyTargets = new Map<string, { chatId: number; replyToMessageId: number }[]>();

function pushReplyTarget(laneKey: string, chatId: number, replyToMessageId: number): void {
	let targets = workerReplyTargets.get(laneKey);
	if (!targets) { targets = []; workerReplyTargets.set(laneKey, targets); }
	targets.push({ chatId, replyToMessageId });
}

function popReplyTarget(laneKey: string): { chatId: number; replyToMessageId: number } | undefined {
	const targets = workerReplyTargets.get(laneKey);
	return targets?.shift();
}

function extractAssistantText(messages: unknown[]): string {
	// Walk messages in reverse to find the last assistant message with text
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (msg.role === "assistant" && msg.content) {
			const parts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text) parts.push(block.text);
			}
			if (parts.length > 0) return parts.join("");
		}
	}
	return "";
}

function setupWorkerEvents(worker: PiWorker): void {
	let streamedText = "";
	let typingTimer: ReturnType<typeof setInterval> | undefined;

	worker.onEvent((event) => {
		switch (event.type) {
			case "agent_start":
				streamedText = "";
				{
					const target = workerReplyTargets.get(worker.laneKey)?.[0];
					if (target) void sendTyping(target.chatId);
				}
				typingTimer = setInterval(() => {
					const target = workerReplyTargets.get(worker.laneKey)?.[0];
					if (target) void sendTyping(target.chatId);
				}, 4000);
				break;

			case "message_update": {
				const ame = event.assistantMessageEvent as { type: string; delta?: string } | undefined;
				if (ame?.type === "text_delta" && ame.delta) {
					streamedText += ame.delta;
				}
				break;
			}

			case "agent_end": {
				if (typingTimer) { clearInterval(typingTimer); typingTimer = undefined; }
				// Prefer streamed deltas; fall back to extracting from agent_end messages
				let replyText = streamedText.trim();
				if (!replyText) {
					const msgs = (event.messages as unknown[]) ?? [];
					replyText = extractAssistantText(msgs).trim();
				}
				const target = popReplyTarget(worker.laneKey);
				if (replyText && target) {
					void log(`worker(${worker.laneKey}) sending reply: ${JSON.stringify(replyText.slice(0, 80))}`);
					void sendChunkedReply(target.chatId, target.replyToMessageId, replyText).then((ids) => {
						for (const id of ids) {
							messageToLane.set(String(id), worker.laneKey);
						}
					});
				} else {
					void log(`worker(${worker.laneKey}) agent_end: no reply text=${JSON.stringify(replyText.slice(0, 40))} target=${JSON.stringify(target)}`);
				}
				streamedText = "";
				break;
			}

			case "extension_error": {
				const errMsg = (event.error as string) ?? "Unknown extension error";
				void log(`worker(${worker.laneKey}) extension error: ${errMsg}`);
				break;
			}
		}
	});
}

// ─── Message Handling ───────────────────────────────────────────────────────

function resolveLaneKey(msg: TelegramMessage, registry: LaneRegistry): string {
	// If replying to a message, check if that message belongs to a lane
	if (msg.reply_to_message) {
		const replyId = String(msg.reply_to_message.message_id);
		// Check if it's a lane anchor
		if (registry.lanes[replyId]) {
			userLastLane.set(msg.chat.id, replyId);
			return replyId;
		}
		// Check if it's a bot reply that belongs to a lane
		const repliedLane = messageToLane.get(replyId);
		if (repliedLane) {
			userLastLane.set(msg.chat.id, repliedLane);
			return repliedLane;
		}
	}
	// Check if user has a pending lane from /new
	const lastLane = userLastLane.get(msg.chat.id);
	if (lastLane) {
		if (registry.lanes[lastLane] || lanes.has(lastLane)) return lastLane;
	}
	return "default";
}

async function resolveAttachments(msg: TelegramMessage): Promise<Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>> {
	const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

	// Text
	const text = (msg.text ?? msg.caption ?? "").trim();
	if (text) parts.push({ type: "text", text });

	// Photos
	if (msg.photo && msg.photo.length > 0) {
		const largest = msg.photo[msg.photo.length - 1];
		const path = await downloadFile(largest.file_id, `photo_${msg.message_id}.jpg`);
		const { readFile: rf } = await import("node:fs/promises");
		const buf = await rf(path);
		parts.push({ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" });
	}

	// Documents (images only for now)
	if (msg.document) {
		const mime = msg.document.mime_type;
		if (mime?.startsWith("image/")) {
			const ext = extname(msg.document.file_name ?? "").toLowerCase() || guessExtFromMime(mime);
			const path = await downloadFile(msg.document.file_id, sanitizeFileName(msg.document.file_name ?? `doc_${msg.message_id}${ext}`));
			const { readFile: rf } = await import("node:fs/promises");
			const buf = await rf(path);
			parts.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
		}
	}

	return parts;
}

function guessExtFromMime(mime: string): string {
	const map: Record<string, string> = {
		"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
	};
	return map[mime] ?? ".bin";
}

async function handleCommand(msg: TelegramMessage, command: { name: string; args: string }): Promise<void> {
	const chatId = msg.chat.id;
	const replyTo = msg.message_id;

	switch (command.name) {
		case "start":
		case "help": {
			await sendMessage(chatId, [
				"*pi Telegram Bridge (parallel mode)*",
				"",
				"/new — Start a new conversation lane",
				"/help — Show this help",
				"/status — Show active lanes",
				"/stop — Abort current turn in default lane",
				"/compact — Compact default lane context",
				"/model — Cycle model in default lane",
				"",
				"Reply to a lane anchor to route to that conversation.",
				"Multiple lanes run in parallel.",
			].join("\n"), replyTo);
			break;
		}

		case "status": {
			const registry = await loadRegistry();
			const lines = [`*Active lanes: ${lanes.size}*`];
			for (const [key, lane] of lanes) {
				const alive = lane.worker.isAlive ? "[alive]" : "[dead]";
				lines.push(`${alive} Lane \`${key}\`${lane.label ? ` (${lane.label})` : ""}`);
			}
			if (lanes.size === 0) lines.push("_No active lanes. Send a message to start the default lane._");
			await sendMessage(chatId, lines.join("\n"), replyTo);
			break;
		}

		case "new": {
			try {
				const { anchorMessageId } = await createNewLane(chatId, replyTo);
				userLastLane.set(chatId, String(anchorMessageId));
				await log(`/new created lane ${anchorMessageId}, set userLastLane`);
			} catch (e) {
				await sendMessage(chatId, `Failed to create new lane: ${e instanceof Error ? e.message : String(e)}`, replyTo);
			}
			break;
		}

		case "stop": {
			const lane = lanes.get("default");
			if (lane?.worker.isAlive) {
				await lane.worker.sendCommand("abort", {});
				await sendMessage(chatId, "Aborted default lane.", replyTo);
			} else {
				await sendMessage(chatId, "No active turn in default lane.", replyTo);
			}
			break;
		}

		case "compact": {
			const lane = lanes.get("default");
			if (!lane?.worker.isAlive) {
				await sendMessage(chatId, "Default lane not running. Send a message first.", replyTo);
				break;
			}
			await lane.worker.sendCommand("compact", {});
			await sendMessage(chatId, "Compaction started on default lane.", replyTo);
			break;
		}

		case "model": {
			const lane = lanes.get("default");
			if (!lane?.worker.isAlive) {
				await sendMessage(chatId, "Default lane not running. Send a message first.", replyTo);
				break;
			}
			const result = await lane.worker.sendCommand("cycle_model", {});
			const model = result.data?.model as { name?: string } | undefined;
			await sendMessage(chatId, model?.name ? `Switched to ${model.name}` : "Model cycled.", replyTo);
			break;
		}

		default:
			await sendMessage(chatId, `Unknown command: /${command.name}`, replyTo);
	}
}

async function handleTelegramMessage(msg: TelegramMessage): Promise<void> {
	if (!msg.from || !msg.text) return;

	// Authorization check
	if (config.allowedUserId && msg.from.id !== config.allowedUserId) {
		await log(`Unauthorized user: ${msg.from.id}`);
		return;
	}

	const chatId = msg.chat.id;
	const text = (msg.text ?? msg.caption ?? "").trim();

	await log(`message from=${msg.from.id} text=${JSON.stringify(text.slice(0, 100))}`);

	// Check if text-only (no photos/documents)
	const hasMedia = !!(msg.photo?.length || msg.document || msg.video || msg.audio || msg.voice || msg.animation || msg.sticker);

	// Handle media groups (album of photos)
	if (msg.media_group_id) {
		const group = mediaGroups.get(msg.media_group_id);
		if (group) {
			group.messages.push(msg);
		} else {
			const state: MediaGroupState = { messages: [msg] };
			mediaGroups.set(msg.media_group_id, state);
			state.timer = setTimeout(async () => {
				mediaGroups.delete(msg.media_group_id!);
				await handleMediaGroup(state.messages);
			}, MEDIA_GROUP_DEBOUNCE_MS);
		}
		return;
	}

	// Command?
	const command = parseCommand(text);
	if (command && (command.name === "new" || command.name === "start" || command.name === "help" ||
		command.name === "status" || command.name === "stop" || command.name === "compact" || command.name === "model")) {
		await handleCommand(msg, command);
		return;
	}

	// Route to lane
	await log(`routing: loading registry`);
	const registry = await loadRegistry();
	const laneKey = resolveLaneKey(msg, registry);
	await log(`routing: laneKey=${laneKey}`);
	const lane = await getOrCreateLane(laneKey, chatId, msg.message_id);
	await log(`routing: lane ready, resolving attachments hasMedia=${hasMedia}`);

	// Resolve attachments
	const parts = hasMedia ? await resolveAttachments(msg) : [];

	// Build the prompt message
	const promptText = text || "(attachment)";
	const images = parts
		.filter((p): p is { type: "image"; data: string; mimeType: string } => p.type === "image");

	// Send to worker
	await log(`routing: sending prompt to worker lane=${laneKey} text=${JSON.stringify(promptText.slice(0, 60))}`);
	pushReplyTarget(laneKey, chatId, msg.message_id);
	try {
		await lane.worker.sendCommand("prompt", {
			message: promptText,
			...(images.length > 0 ? { images } : {}),
		});
		await log(`routing: prompt sent to worker, awaiting response`);
	} catch (e) {
		// Remove the pushed target on error
		popReplyTarget(laneKey);
		await log(`routing: prompt error: ${e instanceof Error ? e.message : String(e)}`);
		await sendChunkedReply(chatId, msg.message_id, `Error sending to worker: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function handleMediaGroup(messages: TelegramMessage[]): Promise<void> {
	// Use the first message for routing, combine all attachments
	if (messages.length === 0) return;
	const first = messages[0];
	const allParts = await resolveAttachments(first);
	// Add photos from other messages in the group
	for (let i = 1; i < messages.length; i++) {
		const parts = await resolveAttachments(messages[i]);
		for (const p of parts) {
			if (p.type === "image") allParts.push(p);
		}
	}
	// Route
	const registry = await loadRegistry();
	const laneKey = resolveLaneKey(first, registry);
	const lane = await getOrCreateLane(laneKey, first.chat.id, first.message_id);

	const promptText = allParts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map(p => p.text)
		.join("\n") || "(photo album)";

	const images = allParts
		.filter((p): p is { type: "image"; data: string; mimeType: string } => p.type === "image");

	try {
		pushReplyTarget(laneKey, first.chat.id, first.message_id);
		await lane.worker.sendCommand("prompt", {
			message: promptText,
			...(images.length > 0 ? { images } : {}),
		});
	} catch (e) {
		popReplyTarget(laneKey);
		await sendChunkedReply(first.chat.id, first.message_id, `Error sending to worker: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await log("=== pi-telegram-router starting ===");

	// Load config
	config = await readConfig();
	if (!config.botToken) {
		console.error("No bot token in telegram.json");
		process.exit(1);
	}

	// Restore lanes from registry
	const registry = await loadRegistry();
	if (registry.lastUpdateId) {
		config.lastUpdateId = registry.lastUpdateId;
	}

	await log(`Bot: @${config.botUsername ?? "unknown"} lastUpdateId=${config.lastUpdateId ?? "none"}`);

	// Delete any webhook
	await deleteWebhook();
	await log("Webhook deleted, polling starts");

	// Start default lane
	await getOrCreateLane("default", config.allowedUserId ?? 0, 0);
	await log("Default lane ready");

	// Poll loop
	let offset = (config.lastUpdateId ?? 0) + 1;
	const pollSignal = new AbortController();

	process.on("SIGINT", async () => {
		await log("SIGINT received, shutting down");
		pollSignal.abort();
		for (const [, lane] of lanes) {
			await lane.worker.stop();
		}
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await log("SIGTERM received, shutting down");
		pollSignal.abort();
		for (const [, lane] of lanes) {
			await lane.worker.stop();
		}
		process.exit(0);
	});

	// Keep-alive: if default lane worker dies, restart it
	setInterval(async () => {
		const defaultLane = lanes.get("default");
		if (defaultLane && !defaultLane.worker.isAlive) {
			await log("Default lane worker died, restarting");
			lanes.delete("default");
			try {
				await getOrCreateLane("default", config.allowedUserId ?? 0, 0);
			} catch (e) {
				await log(`Failed to restart default lane: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}, 30000);

	while (!pollSignal.signal.aborted) {
		try {
			const updates = await getUpdates(offset, pollSignal.signal);
			for (const update of updates) {
				offset = update.update_id + 1;

				// Persist last update ID
				registry.lastUpdateId = update.update_id;
				await saveRegistry(registry);

				if (update.message) {
					await handleTelegramMessage(update.message).catch(async (e) => {
						await log(`Error handling message: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
					});
				}
				if (update.edited_message) {
					// Edited messages: just log for now
					await log(`Edited message ${update.edited_message.message_id} (ignored)`);
				}
			}
		} catch (e) {
			if (pollSignal.signal.aborted) break;
			const errMsg = e instanceof Error ? e.message : String(e);
			await log(`Poll error: ${errMsg}`);
			await new Promise((r) => setTimeout(r, 3000));
		}
	}

	await log("=== pi-telegram-router stopped ===");
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as TelegramConfig;
	} catch { return {}; }
}

main().catch((e) => {
	console.error("Fatal:", e);
	void log(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
	process.exit(1);
});
