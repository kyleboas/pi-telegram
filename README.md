# pi-telegram

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM bridge for pi.

## Install

From git:

```bash
pi install git:github.com/badlogic/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/badlogic/pi-telegram
```

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

Start pi, then run:

```bash
/telegram-setup
```

Paste the bot token when prompted.

The extension stores config in:

```text
~/.pi/agent/telegram.json
```

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
```

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status:

```bash
/telegram-status
```

## Pair your Telegram account

After token setup and `/telegram-connect`:

1. Open the DM with your bot in Telegram
2. Send `/start`

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:
- downloads them to `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:
- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

That aborts the active pi turn.

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

The extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Parallel Mode (Standalone Router)

In addition to the session-local extension above, `pi-telegram-router.ts` provides a **standalone parallel router** that runs without a terminal open and supports multiple concurrent conversation lanes.

### How it works

- One Node.js process polls Telegram and manages worker lanes.
- Each lane is a separate `pi --mode rpc` child process.
- `/new` starts a new lane and posts an anchor message. Reply to any anchor to route to that lane's conversation.
- All lanes process in true parallel — no terminal or TUI needed.

### Setup

1. Ensure `pi` is installed at `/usr/bin/pi` (or edit `PI_BIN` in the script).
2. Configure `~/.pi/agent/telegram.json` with your bot token (same config as the extension).
3. Run the router:

```bash
node /path/to/pi-telegram-router.ts
```

Or install it somewhere on your PATH:

```bash
cp pi-telegram-router.ts ~/.local/bin/pi-telegram-router.ts
chmod +x ~/.local/bin/pi-telegram-router.ts
```

### Commands

| Command     | Description                                      |
|-------------|--------------------------------------------------|
| `/new`      | Start a new conversation lane                    |
| `/status`   | Show active lanes                                |
| `/stop`     | Abort current turn in the default lane           |
| `/compact`  | Compact context in the default lane              |
| `/model`    | Cycle model in the default lane                  |
| `/help`     | Show help                                        |

### Features

- **Parallel lanes**: Multiple independent pi conversations at once
- **Persistent sessions**: Lanes survive restarts via `telegram-lanes.json` registry
- **Media support**: Photos, image documents, and media groups (albums)
- **Streaming**: Typing indicators while the agent is generating
- **Auto-restart**: Default lane worker is restarted automatically if it dies

### Notes

- The router and the extension should not be used simultaneously with the same bot.
- Lane state is persisted in `~/.pi/agent/telegram-lanes.json`.
- Debug logs go to `~/.pi/agent/telegram-parallel-debug.log`.

---

## Notes

- Only one pi session should be connected to the bot at a time (extension mode)
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT
