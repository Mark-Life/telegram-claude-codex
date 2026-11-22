# AGENTS.md

A private Telegram bot that runs Codex, Claude Code or pi on the owner's server. Turborepo, Bun, Effect v4, TypeScript 7.

- `apps/telegram` is the bot, and `packages/agent` drives the providers. `packages/db` holds SQLite, `packages/env` holds config, `packages/core` holds logging, `packages/api` is the HTTP API contract (its server runs in `apps/telegram/src/api`). `apps/web` and `packages/ui` are an unused Next.js template.
- Before you change an area, read its notes in `.docs/architecture/`. Read only the ones you touch: `telegram-app`, `agent`, `models`, `access`, `data`, `copy-and-prompts`, `deploy-and-tooling`.
- For TypeScript, load `.agents/skills/quality-code/SKILL.md`. When you pick a new library, check `.docs/stack.md`.
- Every check must pass before a commit: `bun run typecheck`, `bun run check` (`bun run fix` auto-fixes) and `bun test`. Add no tests unless asked. Test the real user flow by hand instead.
- Every string a user reads lives in `apps/telegram/src/i18n` (`ru/` is the source, `en/` must match). Migrations are additive only, and a shipped migration is never edited.
- Setup and deployment are documented only in `README.md`, and the user reference only in `docs/`. Keep both current when you change behaviour.
