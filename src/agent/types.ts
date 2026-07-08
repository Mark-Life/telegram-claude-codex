import type { Cause, Queue } from "effect";
import type { AgentError } from "./errors";

/** Supported coding-agent provider identifiers */
export type ProviderId = "claude" | "codex";

/** Normalized internal event model consumed by telegram.ts (provider-agnostic) */
export type AgentEvent =
  | { kind: "session_init"; sessionId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use"; name: string; input: string }
  | { kind: "thinking_start" }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_done"; durationMs: number }
  | { kind: "plan_ready"; planPath: string }
  | { kind: "agent_started"; taskId: string; description: string }
  | {
      kind: "agent_done";
      taskId: string;
      description: string;
      status: string;
      durationMs?: number;
      totalTokens?: number;
      toolUses?: number;
    }
  | {
      kind: "result";
      text: string;
      sessionId: string;
      // Optional: only providers that actually report economics populate these.
      // Providers that never report them (e.g. Codex) leave them undefined so
      // downstream `?? null` correctly degrades to NULL instead of a fabricated 0.
      cost?: number;
      durationMs: number;
      turns?: number;
      totalTokens?: number;
    }
  | { kind: "error"; message: string; class?: AgentError };

/** The event queue bridged from an Effect producer fiber to the AsyncGenerator consumer. */
export type EventQueue = Queue.Queue<AgentEvent, Cause.Done>;

/** Options passed to a provider run, normalized across providers */
export interface RunOptions {
  chatId: number;
  projectDir: string;
  prompt: string;
  sessionId?: string;
  userId: number;
}

/** Feature flags describing what a provider supports */
export interface ProviderCapabilities {
  cost: boolean;
  planMode: boolean;
  subagents: boolean;
  thinking: boolean;
}

/** Metadata for a stored agent session */
export interface SessionInfo {
  lastActiveAt: string;
  projectName: string;
  projectPath: string;
  sessionId: string;
  startedAt: string;
  summary: string;
}

/** Minimal contract the generic runner needs to spawn and parse a provider */
export interface ProviderSpec {
  buildArgs: (opts: RunOptions) => string[];
  buildEnv: (
    opts: RunOptions,
    base: Record<string, string | undefined>
  ) => Record<string, string>;
  command: string;
  createParser: () => (lines: string[]) => Generator<AgentEvent>;
  id: ProviderId;
}

/** Full provider definition: spec plus capabilities and session history access */
export interface AgentProvider extends ProviderSpec {
  capabilities: ProviderCapabilities;
  clearSessionCache: () => void;
  displayName: string;
  getSessionProject: (sessionId: string) => string | undefined;
  listAllSessions: () => SessionInfo[];
}
