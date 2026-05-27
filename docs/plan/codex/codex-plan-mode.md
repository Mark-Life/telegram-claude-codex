# Codex Plan Mode — Phase 1 Research (VERIFIED)

How (and whether) to give Codex the same "plan → review → approve" flow the bot has for Claude. Codex CLI **v0.132.0**.

## Background: how Claude plan mode works today

`src/claude.ts:210-220` + `src/bot.ts:658-792`:
1. Claude (in plan mode) writes a plan file under `.claude/plans/` (detected via a `Write` tool whose `file_path` includes `.claude/plans/`).
2. Claude calls the **`ExitPlanMode`** tool → parser emits `{ kind: "plan_ready", planPath }`.
3. The bot reads the plan file and shows it with action buttons (Approve / Approve+resume / Modify).

Codex has **neither** the `.claude/plans/` directory convention **nor** an `ExitPlanMode` tool. So the question is: can we manufacture an equivalent reliably from `codex exec --json`?

---

## What Codex offers natively (investigated)

### 1. `--sandbox read-only` = a real "plan without editing" mode ✅ (VERIFIED)

`codex exec -s read-only -c 'approval_policy="never"'` makes Codex **physically unable to write**. Spike: asked it to create `readonly-test.txt`; the file was **not** created and Codex completed cleanly explaining why:

```json
{"type":"item.completed","item":{"type":"agent_message","text":"I can't create `readonly-test.txt` because the current workspace is mounted read-only, and approvals are disabled for this session."}}
{"type":"turn.completed","usage":{...}}
```
(`samples/extra-readonly.jsonl`)

This is a genuine guardrail (Codex can read/analyze but not mutate), but it is **not a plan protocol**: there is no structured "here is the plan" event, and the plan text is just normal `agent_message` prose. Read-only is useful as a *belt-and-suspenders* guarantee that a planning run won't touch the repo, but it cannot, by itself, signal "plan ready."

### 2. Interactive `/plan` and `update_plan` — NOT in `exec` (checked)

The interactive Codex TUI has a plan affordance, and the model has an internal `update_plan` tool, but **`codex exec --json` emits no `plan`/`update_plan`/approval event** on stdout (none observed across any spike; the only item types are `agent_message`, `command_execution`, `file_change`, `reasoning`). There is no app-server/structured-approval event surfaced through the `exec` JSONL stream that maps onto `plan_ready`.

### 3. `--output-schema` (structured final output) — possible but heavy

`codex exec --output-schema <FILE>` constrains the **final** assistant message to a JSON schema. One could force `{ "plan": "...", "ready": true }`. But it only governs the *final* message, fights with the streaming/narration UX, and is brittle. Not recommended as the primary mechanism (see outcomes).

---

## Can "plan is ready" be reliably detected from JSONL? ✅ YES

Spike #6: prompted *"Produce a plan only. Do NOT implement. Write the plan to `.codex/plans/PLAN.md`. After writing, stop."* with the normal bypass flags.

Result (`samples/06-plan-mode.jsonl`):
- Codex created `.codex/plans/PLAN.md` (well-formed markdown — see below) and **did not** create the implementation file (`reverse.ts`).
- The write surfaced as a **`file_change` event with a detectable path**:

```json
{"type":"item.completed","item":{"id":"item_3","type":"file_change",
  "changes":[{"path":"/private/.../.codex/plans/PLAN.md","kind":"add"}],"status":"completed"}}
```

The on-disk plan file:

```md
# Plan: Add `reverse.ts`
## Goal
Add a new TypeScript file named `reverse.ts` that exports a function for reversing a string.
## Proposed Steps
1. Create `reverse.ts` at the project root.
2. Define and export a function ...
...
```

→ **Detection is reliable**: watch `file_change` items for any `changes[].path` ending in `.codex/plans/` (mirrors the existing Claude `.claude/plans/` check almost exactly). The bot then reads that file and presents it — the *entire downstream plan UI in `bot.ts` is reusable unchanged*.

---

## Evaluation of the four possible outcomes

| # | Approach | Verdict |
|---|----------|---------|
| **1** | **Prompt convention + known path (`.codex/plans/`) + `file_change` detection** | ✅ **RECOMMENDED.** Verified working. Symmetric with Claude's `.claude/plans/` mechanism, so `bot.ts` plan handling is reused as-is. The signal (a `file_change` to a known path) is a real protocol event, not string-sniffing. |
| 2 | Sentinel marker in the final `agent_message` | Workable fallback but inferior: requires parsing prose, no plan *file* to render with buttons, and the bot's plan flow expects a `planPath`. Fragile. |
| 3 | Codex native mechanism (app-server / `update_plan` / approval event) | ❌ Not available through `codex exec --json`. No such event observed. Would require the interactive protocol, which the bot does not use. |
| 4 | No reliable path — keep plan mode Claude-only | ❌ Unnecessary. Outcome 1 is demonstrably reliable. |

**Recommendation: Outcome 1.** A prompt convention asking Codex to write the plan to `.codex/plans/PLAN.md` and stop, detected via the `file_change` JSONL event, then reusing the existing `plan_ready` UI. `--sandbox read-only` can optionally back it up to *guarantee* no edits during a planning turn, but is not required for detection.

---

## Phase 6 implementation spec (concrete)

### Detection logic (in `src/agent/codex.ts` parser)

Mirror the existing Claude logic. In the JSONL parser, on an `item.completed` with `item.type === "file_change"`, for each `change` in `item.changes`:

```ts
// existing: emit tool_use Write/Edit per change
if (PLAN_MODE && change.path.includes("/.codex/plans/")) {
  yield { kind: "plan_ready", planPath: change.path };
}
```

- No `ExitPlanMode` analogue is needed — Codex has no second "exit plan" signal, so the **file-write itself is the trigger** (simpler than Claude, which needs Write *then* ExitPlanMode). Emit `plan_ready` directly on the plan-file `file_change`.
- Guard with a parser flag so it only fires when the bot launched a planning turn (don't treat an incidental write to that path during a normal run as a plan). Pass this via run options (see below).

### New path convention

- `.codex/plans/PLAN.md` (project-relative, created by Codex on demand). Document it alongside `.claude/plans/`. Consider git-ignoring `.codex/plans/` in target repos (optional, same as `.claude/`).

### Plan-mode prompt (bot-injected, Codex only)

When the user triggers plan mode under Codex, prefix/replace the prompt with a convention block, e.g.:

```
Produce a plan only. Do NOT implement or modify any source files.
Write the plan as markdown to ./.codex/plans/PLAN.md (create the directory if needed).
After writing the plan file, stop.

User request:
<original prompt>
```

Optionally also run that turn with `-s read-only`… **caveat:** read-only blocks *all* writes including the plan file. To use read-only + still allow the plan file, scope it with `--add-dir <project>/.codex/plans` — **but** spike showed `--add-dir` is only on the first-turn `exec` (not `resume`), and read-only generally forbids writes. Simpler and verified: use the **normal bypass flags** for the planning turn (Codex reliably self-restricts to only the plan file when instructed, as spike #6 confirmed) and rely on the prompt convention. Treat read-only as a future hardening option, not a launch requirement.

### `bot.ts` changes

- The plan-presentation, Approve/Modify buttons, and execution paths (`src/bot.ts:658-792`) are **provider-agnostic once `plan_ready` carries a `planPath`** — they just read the file and re-prompt. Reuse unchanged.
- Plan execution (approve) → `runAgent("codex", { ... })` with the plan as prompt; resume-approve → `codex exec resume <sid> "approved, proceed"`. Both already match the plan's Phase-6 notes in `claude-code-functions.md`.
- The only gating change: show plan buttons / honor `plan_ready` only when `capabilities.planMode` is true (Phase 5 already introduces this gate).

### `capabilities.planMode` for Codex

**Flip to `true`** in `registry.ts` once the above lands. The detection is reliable, the plan file is real and renderable, and the existing UI is reusable. Until Phase 6 ships, keep it `false` (Codex runs normally, no plan buttons).

### Risks / caveats

- **Model compliance**: detection depends on Codex actually writing to the path. In the spike it complied on the first try, but a stubborn model could write elsewhere or inline the plan. Mitigations: a firm prompt convention (above); a fallback that, if `turn.completed` arrives in a planning turn with **no** plan-path `file_change`, treats the final `agent_message` as the plan (degrade to Outcome 2). Recommend implementing the primary path first, adding the fallback only if needed.
- **No `ExitPlanMode` = no explicit "I'm done planning" beyond the file write.** Acceptable: emit `plan_ready` on the plan-file write and let `turn.completed` end the turn.
- Path matching must be on the **normalized** path (macOS reports `/private/var/...`); use a substring check on `/.codex/plans/` rather than an exact prefix.
