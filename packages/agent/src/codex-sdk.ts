import type { Codex, CodexOptions } from "@openai/codex-sdk";

/**
 * A Codex SDK client. The SDK is imported on the first call, not with the
 * provider registry, so a host that never runs Codex never loads it.
 */
export const newCodex = async (options: CodexOptions): Promise<Codex> => {
  const sdk = await import("@openai/codex-sdk");
  return new sdk.Codex(options);
};
