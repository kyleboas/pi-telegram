import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
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
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
	usageLimitRetries?: number;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

// Track models disabled due to rate limits: model key -> expiry timestamp
const disabledModels = new Map<string, number>();

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

function roundUsd(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function formatUsd(value: number): string {
	return value < 0.0001 && value > 0 ? "<$0.0001" : `$${value.toFixed(4)}`;
}

function estimateRateCost(units: number, perMillionUsd: number): number {
	return roundUsd((units / 1_000_000) * perMillionUsd);
}

// Parse duration strings like "~5656 min", "1 hour", "30 seconds" and return milliseconds
function parseDurationMs(durationStr: string): number {
	const timeMatch = durationStr.match(/(\d+(?:\.\d+)?)\s*([a-z]+)/i);
	if (!timeMatch) return 0;

	const value = parseFloat(timeMatch[1]);
	const unit = timeMatch[2].toLowerCase();

	const unitMap: Record<string, number> = {
		"ms": 1,
		"s": 1000,
		"sec": 1000,
		"second": 1000,
		"m": 60 * 1000,
		"min": 60 * 1000,
		"minute": 60 * 1000,
		"h": 60 * 60 * 1000,
		"hr": 60 * 60 * 1000,
		"hour": 60 * 60 * 1000,
		"d": 24 * 60 * 60 * 1000,
		"day": 24 * 60 * 60 * 1000,
	};

	const multiplier = unitMap[unit] || 0;
	return multiplier > 0 ? Math.round(value * multiplier) : 0;
}

// Get model identifier key
function getModelKey(provider?: string, modelId?: string): string {
	return `${provider || "unknown"}/${modelId || "unknown"}`;
}

// Check if a model is currently disabled due to rate limit
function isModelDisabled(provider?: string, modelId?: string): boolean {
	const key = getModelKey(provider, modelId);
	const expiryTime = disabledModels.get(key);
	if (!expiryTime) return false;

	if (Date.now() >= expiryTime) {
		disabledModels.delete(key);
		return false;
	}
	return true;
}

// Mark a model as disabled for a specified duration
function disableModelUntil(provider?: string, modelId?: string, durationMs?: number): void {
	if (!durationMs || durationMs <= 0) return;
	const key = getModelKey(provider, modelId);
	const expiryTime = Date.now() + durationMs;
	disabledModels.set(key, expiryTime);
}

// Get remaining disabled time in seconds for display
function getDisabledTimeRemaining(provider?: string, modelId?: string): number {
	const key = getModelKey(provider, modelId);
	const expiryTime = disabledModels.get(key);
	if (!expiryTime) return 0;
	const remaining = Math.max(0, expiryTime - Date.now());
	return Math.round(remaining / 1000);
}


async function fetchSpendBreakdown(): Promise<{ day: string; spentUsd: number; dailyLimitUsd: number; sections: Array<{ title: string; items: Array<{ label: string; amountUsd: number }> }> }> {
	const statusRes = await fetch("https://budget-guard.heyboas.workers.dev/status");
	if (!statusRes.ok) throw new Error(`Budget Guard returned HTTP ${statusRes.status}`);
	const state = await statusRes.json() as any;
	const day = state.currentDay as string;

	const adminToken = await readFile(join(homedir(), "code", "budget-guard", ".admin_token"), "utf8").then((t) => t.trim()).catch(() => "");
	let events: any[] = [];
	if (adminToken) {
		const eventsRes = await fetch(`https://budget-guard.heyboas.workers.dev/admin/events?day=${day}`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		if (eventsRes.ok) {
			const eventsData = await eventsRes.json() as any;
			events = eventsData.items || [];
		}
	}

	const serviceSummary = events.reduce((acc: Record<string, number>, event: any) => {
		if (event.type === "record" && typeof event.source === "string" && !event.source.startsWith("cloudflare-")) {
			acc[event.source] = roundUsd((acc[event.source] || 0) + Number(event.amountUsd || 0));
		}
		return acc;
	}, {});

	const sections: Array<{ title: string; items: Array<{ label: string; amountUsd: number }> }> = [];
	const serviceItems = Object.entries(serviceSummary)
		.sort((a, b) => b[1] - a[1])
		.map(([label, amountUsd]) => ({ label, amountUsd }));
	if (serviceItems.length > 0) {
		sections.push({ title: "Service-reported", items: serviceItems });
	}

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (accountId && apiToken) {
		const query = `query SpendBreakdown($accountTag: String!, $start: String!, $end: String!) {
			viewer {
				accounts(filter: { accountTag: $accountTag }) {
					aiGatewayRequestsAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { gateway provider model }
						sum { cost }
					}
					aiInferenceAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { modelId requestSource tag }
						sum { totalInputTokens totalOutputTokens }
					}
					workersInvocationsAdaptive(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { scriptName }
						sum { requests cpuTimeUs }
					}
					pagesFunctionsInvocationsAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { scriptName }
						sum { requests duration }
					}
					d1AnalyticsAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { databaseId }
						sum { rowsRead rowsWritten }
					}
					kvOperationsAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { actionType namespaceId }
						count
					}
					vectorizeQueriesAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { vectorizeIndexId }
						sum { queriedVectorDimensions }
					}
					vectorizeV2QueriesAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
						dimensions { indexName operation }
						sum { queriedVectorDimensions }
					}
				}
			}
		}`;
		const graphqlRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				query,
				variables: { accountTag: accountId, start: `${day}T00:00:00.000Z`, end: `${day}T23:59:59.999Z` },
			}),
		});
		if (graphqlRes.ok) {
			const graphql = await graphqlRes.json() as any;
			const account = graphql?.data?.viewer?.accounts?.[0];
			if (account) {
				const d1Names: Record<string, string> = {
					"8e2df5bc-4e61-4fce-bbfd-127c41fac3c1": "secondbrain (D1)",
					"a40fea6c-9e63-47b3-a697-3598b1fafaa4": "tacticsjournal.com (D1)",
				};
				const kvNames: Record<string, string> = {
					"25f958ce444b49338338bff6de73d0bc": "budget-guard (KV)",
				};
				const cloudflareItems: Array<{ label: string; amountUsd: number }> = [];

				for (const row of account.aiGatewayRequestsAdaptiveGroups || []) {
					const gateway = row?.dimensions?.gateway || "unknown";
					const provider = row?.dimensions?.provider || "unknown";
					const model = row?.dimensions?.model || "unknown";
					const cost = Number(row?.sum?.cost || 0);
					if (cost > 0) cloudflareItems.push({ label: `${gateway} (AI Gateway · ${provider}/${model})`, amountUsd: roundUsd(cost) });
				}

				const workersAiPricing: Record<string, { input: number; output: number }> = {
					"@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
					"@cf/meta/llama-3.1-8b-instruct-fast": { input: 0.015, output: 0.025 },
					"@cf/meta/llama-4-scout": { input: 0.12, output: 0.18 },
					"@cf/baai/bge-base-en-v1.5": { input: 0.012, output: 0 },
					"@cf/baai/bge-m3": { input: 0.012, output: 0 },
				};
				for (const row of account.aiInferenceAdaptiveGroups || []) {
					const modelId = String(row?.dimensions?.modelId || "unknown");
					const pricing = workersAiPricing[modelId] || (modelId.includes("bge") ? workersAiPricing["@cf/baai/bge-base-en-v1.5"] : undefined);
					if (!pricing) continue;
					const inputTokens = Number(row?.sum?.totalInputTokens || 0);
					const outputTokens = Number(row?.sum?.totalOutputTokens || 0);
					const cost = roundUsd((inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output);
					if (cost > 0) cloudflareItems.push({ label: `Workers AI (${modelId})`, amountUsd: cost });
				}

				for (const row of account.workersInvocationsAdaptive || []) {
					const scriptName = row?.dimensions?.scriptName || "unknown worker";
					const requests = Number(row?.sum?.requests || 0);
					const cpuMs = Number(row?.sum?.cpuTimeUs || 0) / 1000;
					const cost = roundUsd(estimateRateCost(requests, 0.30) + estimateRateCost(cpuMs, 0.02));
					if (cost > 0) cloudflareItems.push({ label: `${scriptName} (Workers)`, amountUsd: cost });
				}

				for (const row of account.pagesFunctionsInvocationsAdaptiveGroups || []) {
					const scriptName = row?.dimensions?.scriptName || "unknown pages function";
					const requests = Number(row?.sum?.requests || 0);
					const duration = Number(row?.sum?.duration || 0);
					const cost = roundUsd(estimateRateCost(requests, 0.30) + estimateRateCost(duration, 0.02));
					if (cost > 0) cloudflareItems.push({ label: `${scriptName} (Pages Functions)`, amountUsd: cost });
				}

				for (const row of account.d1AnalyticsAdaptiveGroups || []) {
					const databaseId = String(row?.dimensions?.databaseId || "unknown");
					const rowsRead = Number(row?.sum?.rowsRead || 0);
					const rowsWritten = Number(row?.sum?.rowsWritten || 0);
					const cost = roundUsd(estimateRateCost(rowsRead, 0.001) + estimateRateCost(rowsWritten, 1.0));
					if (cost > 0) cloudflareItems.push({ label: d1Names[databaseId] || `${databaseId} (D1)`, amountUsd: cost });
				}

				const kvByNamespace: Record<string, { read: number; writeLike: number }> = {};
				for (const row of account.kvOperationsAdaptiveGroups || []) {
					const namespaceId = String(row?.dimensions?.namespaceId || "unknown");
					const actionType = String(row?.dimensions?.actionType || "other").toLowerCase();
					const count = Number(row?.count || 0);
					kvByNamespace[namespaceId] ||= { read: 0, writeLike: 0 };
					if (actionType === "read") kvByNamespace[namespaceId].read += count;
					else kvByNamespace[namespaceId].writeLike += count;
				}
				for (const [namespaceId, usage] of Object.entries(kvByNamespace)) {
					const cost = roundUsd(estimateRateCost(usage.read, 0.50) + estimateRateCost(usage.writeLike, 5.0));
					if (cost > 0) cloudflareItems.push({ label: kvNames[namespaceId] || `${namespaceId} (KV)`, amountUsd: cost });
				}

				for (const row of account.vectorizeQueriesAdaptiveGroups || []) {
					const indexId = String(row?.dimensions?.vectorizeIndexId || "unknown");
					const dims = Number(row?.sum?.queriedVectorDimensions || 0);
					const cost = roundUsd(estimateRateCost(dims, 0.01));
					if (cost > 0) cloudflareItems.push({ label: `${indexId} (Vectorize v1)`, amountUsd: cost });
				}
				for (const row of account.vectorizeV2QueriesAdaptiveGroups || []) {
					const indexName = String(row?.dimensions?.indexName || "unknown");
					const dims = Number(row?.sum?.queriedVectorDimensions || 0);
					const cost = roundUsd(estimateRateCost(dims, 0.01));
					if (cost > 0) cloudflareItems.push({ label: `${indexName} (Vectorize)`, amountUsd: cost });
				}

				const merged = new Map<string, number>();
				for (const item of cloudflareItems) merged.set(item.label, roundUsd((merged.get(item.label) || 0) + item.amountUsd));
				const items = [...merged.entries()].map(([label, amountUsd]) => ({ label, amountUsd })).sort((a, b) => b.amountUsd - a.amountUsd);
				if (items.length > 0) sections.push({ title: "Cloudflare detailed", items });
			}
		}
	}

	if (sections.length === 0) {
		sections.push({ title: "Recorded spend", items: [{ label: "Total", amountUsd: Number(state.spentUsd || 0) }] });
	}

	return { day, spentUsd: Number(state.spentUsd || 0), dailyLimitUsd: Number(state.dailyLimitUsd || 0), sections };
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
	try {
		const { chmod } = await import("node:fs/promises");
		await chmod(CONFIG_PATH, 0o600);
	} catch (_e) { /* ignore */ }
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	let setupPairingExpiry: number | undefined;
	const RATE_WINDOW_MS = 60_000; // 1 minute
	const MAX_RATE_MESSAGES = 10;
	const rateLimitBuckets = new Map<number, number[]>();
	const mediaGroups = new Map<string, TelegramMediaGroupState>();

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
		const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
		if (contentLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(`File exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit`);
		}
		const arrayBuffer = await response.arrayBuffer();
		if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(`File exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit`);
		}
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId);
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText });
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text);
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: chunk,
			});
			lastMessageId = sent.message_id;
		}
		return lastMessageId;
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("")
				.trim();
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			setupPairingExpiry = Date.now() + 5 * 60 * 1000; // 5 minute pairing window
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram within 5 minutes to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`);
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			return;
		}

		if (lower === "/spend") {
			try {
				const breakdown = await fetchSpendBreakdown();
				const lines: string[] = [`Daily Spend Breakdown (${breakdown.day})`, ""];
				for (const section of breakdown.sections) {
					lines.push(`${section.title}:`);
					for (const item of section.items) {
						lines.push(`• ${item.label}: ${formatUsd(item.amountUsd)}`);
					}
					lines.push("");
				}
				lines.push(`Total: ${formatUsd(breakdown.spentUsd)} / $${breakdown.dailyLimitUsd.toFixed(2)}`);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to fetch spend: ${message}`);
			}
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi. Commands: /status, /spend, /compact, stop.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns);
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content);
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		if (config.allowedUserId === undefined) {
			// Only allow pairing within 5 minutes of setup
			if (setupPairingExpiry && Date.now() > setupPairingExpiry) {
				await sendTextReply(message.chat.id, message.message_id, "Pairing window expired. Run /telegram-setup again in pi.");
				return;
			}
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			return;
		}

		// Rate limiting
		const now = Date.now();
		const userTimes = rateLimitBuckets.get(message.from.id) ?? [];
		const recent = userTimes.filter((t) => now - t < RATE_WINDOW_MS);
		if (recent.length >= MAX_RATE_MESSAGES) {
			return;
		}
		recent.push(now);
		rateLimitBuckets.set(message.from.id, recent);

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					config.lastUpdateId = update.update_id;
					await writeConfig(config);
					await handleUpdate(update, ctx);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise) return;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("spend", {
		description: "Show Budget Guard spend breakdown",
		handler: async (_args, ctx) => {
			try {
				const breakdown = await fetchSpendBreakdown();
				const theme = ctx.ui.theme;
				const lines: string[] = [theme.fg("accent", `Daily Spend Breakdown (${breakdown.day})`)];
				for (const section of breakdown.sections) {
					lines.push(theme.fg("muted", section.title));
					for (const item of section.items) {
						lines.push(`  ${item.label}: ${formatUsd(item.amountUsd)}`);
					}
				}
				lines.push(theme.fg("success", `Total: ${formatUsd(breakdown.spentUsd)} / $${breakdown.dailyLimitUsd.toFixed(2)}`));
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to fetch spend: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		queuedTelegramTurns = [];
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
				startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await clearPreview(turn.chatId);
			const errorMessage = assistant.errorMessage || "";
			
			// Check if this is a rate/usage limit error from any provider and retry hasn't been exceeded
			const isUsageLimitError = /usage limit|rate limit|quota exceeded|overloaded|too many requests|throttled/i.test(errorMessage);
			const retryCount = turn.usageLimitRetries ?? 0;
			const MAX_USAGE_LIMIT_RETRIES = 3;
			
			if (isUsageLimitError && retryCount < MAX_USAGE_LIMIT_RETRIES && turn) {
				// Store current model before cycling
				const failedModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
				
				// Extract duration from error message (e.g., "~5656 min" or "1 hour")
				const durationMatch = errorMessage.match(/~?(\d+(?:\.\d+)?\s*(?:min|minute|hour|hr|h|second|sec|s|day|d))/);
				const durationMs = durationMatch ? parseDurationMs(durationMatch[0]) : 0;
				
				// Mark the current model as disabled for the specified duration
				if (failedModel) {
					disableModelUntil(failedModel.provider, failedModel.id, durationMs);
				}
				
				// Cycle to the next model, skipping disabled ones
				let newModel: { name?: string; id?: string; provider?: string } | undefined;
				let cyclesAttempted = 0;
				const MAX_CYCLES = 10; // Prevent infinite loops
				
				do {
					const cycleResult = await ctx.worker.sendCommand("cycle_model", {});
					newModel = cycleResult.data?.model as { name?: string; id?: string; provider?: string } | undefined;
					cyclesAttempted++;
					
					if (!newModel || !isModelDisabled(newModel.provider, newModel.id)) {
						break; // Found an enabled model
					}
				} while (cyclesAttempted < MAX_CYCLES);
				
				const modelName = newModel?.name ?? `${newModel?.provider}/${newModel?.id}`;
				const disabledUntil = failedModel ? getDisabledTimeRemaining(failedModel.provider, failedModel.id) : 0;
				const timeStr = disabledUntil > 0 ? ` (unavailable for ${disabledUntil}s)` : "";
				
				// Notify user of the cycle and retry
				await sendTextReply(
					turn.chatId,
					turn.replyToMessageId,
					`Rate limit hit${timeStr}. Cycling to ${modelName}... retrying.`
				);
				
				// Re-queue the turn for retry with incremented counter
				turn.usageLimitRetries = retryCount + 1;
				queuedTelegramTurns.unshift(turn);
				if (queuedTelegramTurns.length === 1) {
					pi.sendUserMessage(turn.content);
				}
				return;
			}
			
			await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await finalizePreview(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		}

		await sendQueuedAttachments(turn);

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			const nextTurn = queuedTelegramTurns[0];
			startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(nextTurn.content);
		}
	});
}
