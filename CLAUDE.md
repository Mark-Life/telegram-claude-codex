# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install dependencies
bun run src/index.ts # start bot
bun --watch run src/index.ts  # dev mode (auto-reload on changes)
bun run lint         # check lint/format (ultracite/biome)
bun run fix          # auto-fix lint/format issues
```

## Architecture

Telegram bot that bridges Claude Code CLI with Telegram. Spawns `claude` CLI as a child process, streams JSON output, and progressively edits Telegram messages with the response.

### Module Overview (src/)

- **index.ts** — Entry point. Validates env vars (`BOT_TOKEN`, `ALLOWED_USER_ID`, `GROQ_API_KEY`, optional `PROJECTS_DIR`), starts bot.
- **bot.ts** — Grammy bot setup, command handlers (`/projects`, `/stop`, `/status`, `/new`), message routing. Maintains per-user state: `activeProject` path and `sessions` map (projectPath → Claude sessionId).
- **claude.ts** — Spawns `claude -p "<prompt>" --output-format stream-json` in the active project dir. Returns `AsyncGenerator<ClaudeEvent>` yielding `text_delta` and `result` events. Tracks one active process per user via `Map<userId, AbortController>`. Resumes sessions with `-r <sessionId>`. 10-min timeout.
- **telegram.ts** — Consumes the Claude event stream via `sendMessageDraft` (300ms interval) with fallback to progressive `editMessageText`. Auto-splits at 4000 chars. Converts Markdown → Telegram HTML (code blocks, bold, italic, links). Falls back to plain text on parse failure. Appends cost/duration/turns footer.
- **transcribe.ts** — Voice message transcription via Groq Whisper (`whisper-large-v3-turbo`).

### Data Flow

```
User message → bot.ts (access control + routing)
  → text: handlePrompt() → claude.ts (spawn CLI) → telegram.ts (stream to chat)
  → voice: transcribe.ts (Groq Whisper) → handlePrompt() → same flow
```

### Key Patterns

- **Session continuity**: Claude session IDs stored per project in user state. Follow-up messages resume the same conversation.
- **One process per user**: New prompt aborts any running Claude process for that user.
- **Streaming**: AsyncGenerator pattern — claude.ts yields events, telegram.ts consumes and streams via `sendMessageDraft` (with edit-based fallback). Draft support auto-detected on first event.
- **HTML formatting**: Markdown converted via regex with placeholder system — code blocks extracted first to avoid nested regex conflicts, then reinserted after other transformations.
