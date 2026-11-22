import { homedir } from "node:os";
import path from "node:path";

/**
 * Where each provider CLI keeps its login and config on this host. Plain
 * paths with no SDK behind them, so a helper script can import them. A
 * provider is listed here whether or not this build registers it: its
 * credentials can sit on the host all the same.
 */

const home = (...parts: string[]) => path.join(homedir(), ...parts);

/** Codex's home: `CODEX_HOME`, else `~/.codex`. */
export const codexHome = () => process.env.CODEX_HOME ?? home(".codex");

/** Codex: its home. */
export const codexStateRoots = () => [codexHome()];

/** Claude Code's config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeConfigDir = () =>
  process.env.CLAUDE_CONFIG_DIR ?? home(".claude");

/**
 * Claude Code: its config dir, plus `~/.claude.json` (account and MCP config),
 * which sits outside `~/.claude` unless `CLAUDE_CONFIG_DIR` moves both.
 */
export const claudeStateRoots = () => [claudeConfigDir(), home(".claude.json")];

/** pi: `PI_CODING_AGENT_DIR`, else `~/.pi`. */
export const piStateRoots = () => [
  process.env.PI_CODING_AGENT_DIR ?? home(".pi"),
];

/** Every provider's state roots: what `send-file-to-user` never sends. */
export const providerStateRoots = () => [
  ...codexStateRoots(),
  ...claudeStateRoots(),
  ...piStateRoots(),
];
