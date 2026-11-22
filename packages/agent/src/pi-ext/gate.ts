/**
 * A pi extension the bot loads into every pi child with `-e`, so a later pi
 * version cannot hand a run a tool silently: any call to a tool outside the
 * run's list (`BOT_PI_TOOLS`, comma-separated, set by the bot) is blocked.
 * An entry ending in `*` is a prefix: `mcp__executor__*` is every tool of
 * the bot's own `executor` server.
 * It runs inside pi, not the bot, and registers no command, since an RPC
 * `prompt` that names one would run it.
 */

interface ToolCall {
  readonly toolName: string;
}

interface Blocked {
  readonly block: true;
  readonly reason: string;
}

/** The part of pi's `ExtensionAPI` the gate uses. */
interface GateApi {
  on: (
    event: "tool_call",
    handler: (call: ToolCall) => Promise<Blocked | undefined>
  ) => void;
}

const entries = (process.env.BOT_PI_TOOLS ?? "")
  .split(",")
  .filter((name) => name.length > 0);
const exact = new Set(entries.filter((name) => !name.endsWith("*")));
const prefixes = entries
  .filter((name) => name.endsWith("*"))
  .map((name) => name.slice(0, -1));

const allowed = (name: string) =>
  exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));

const gate = (pi: GateApi) => {
  pi.on("tool_call", async (call) =>
    allowed(call.toolName)
      ? undefined
      : await Promise.resolve({
          block: true,
          reason: `${call.toolName} is not available in this run`,
        } as const)
  );
};

export default gate;
