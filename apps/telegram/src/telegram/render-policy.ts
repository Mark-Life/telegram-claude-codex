/**
 * What the streaming layer is allowed to put in the chat for one run.
 *
 * Quiet is the production mode: the run shows up as a typing indicator and
 * ends as one message with the answer. Full mode is the dev view and keeps
 * every phase preview, phase message and the metadata footer.
 */
export interface RenderPolicy {
  /** Append the metadata footer (project/cost/time/turns) to the final message. */
  footer: boolean;
  /** Render technical phases — tool calls, thinking, sub-agents — as drafts and persisted messages. */
  technicalPhases: boolean;
  /** Preview assistant text as an ephemeral draft while it streams. */
  textDrafts: boolean;
}

export const VERBOSITY_LEVELS = ["full", "quiet"] as const;

export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

/** Silent until the answer: no drafts, no phase messages, no footer. */
export const QUIET_POLICY = {
  footer: false,
  technicalPhases: false,
  textDrafts: false,
} as const satisfies RenderPolicy;

/** Dev view: everything the stream produces is rendered. */
export const FULL_POLICY = {
  footer: true,
  technicalPhases: true,
  textDrafts: true,
} as const satisfies RenderPolicy;

/** Read the stored `verbosity` setting; unset or unknown means quiet. */
export const parseVerbosity = (raw?: string): Verbosity =>
  raw === "full" ? "full" : "quiet";

/** Render policy for a verbosity level. */
export const policyFor = (verbosity: Verbosity): RenderPolicy =>
  verbosity === "full" ? FULL_POLICY : QUIET_POLICY;
