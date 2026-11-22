import { Option, Schema } from "effect";

/**
 * One tool call as the chat shows it: the tool's name and the one input field
 * that says what it did. A provider that reports tool calls with their raw
 * input (Claude, pi) goes through here; Codex reports typed items and summarizes
 * them itself.
 */

/** The input field worth showing, per tool name. */
const INPUT_FIELD = {
  Agent: "description",
  Bash: "command",
  Edit: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  NotebookEdit: "notebook_path",
  Read: "file_path",
  Skill: "skill",
  Task: "description",
  WebFetch: "url",
  WebSearch: "query",
  Write: "file_path",
  // pi's own tools.
  bash: "command",
  edit: "path",
  find: "pattern",
  grep: "pattern",
  ls: "path",
  read: "path",
  write: "path",
} as const satisfies Record<string, string>;

const inputFieldOf = (name: string) =>
  Object.entries(INPUT_FIELD).find(([tool]) => tool === name)?.[1];

const MAX_CHARS = 80;
const ELLIPSIS = "...";

const MCP_TOOL = /^mcp__(?<server>.+?)__(?<tool>.+)$/u;

const decodeFields = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown)
);
const decodeText = Schema.decodeUnknownOption(Schema.String);

/** A tool call as the provider reported it; `input` is the tool's raw input. */
interface ToolCall {
  input: Parameters<typeof decodeFields>[0];
  name: string;
}

const clip = (text: string) =>
  text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS - ELLIPSIS.length)}${ELLIPSIS}`
    : text;

/** One string field of a tool's input, or empty when it has none. */
const fieldOf = (call: ToolCall, field: string | undefined) =>
  field === undefined
    ? ""
    : Option.getOrElse(
        decodeFields(call.input).pipe(
          Option.flatMap((fields) => decodeText(fields[field]))
        ),
        () => ""
      );

/**
 * The `tool_use` event of one call. An MCP tool (`mcp__server__tool`) shows
 * as the tool, with its server as the input.
 */
export const summarizeTool = (call: ToolCall) => {
  const mcp = MCP_TOOL.exec(call.name)?.groups;
  if (mcp?.server !== undefined && mcp.tool !== undefined) {
    return { input: mcp.server, name: mcp.tool };
  }
  return {
    input: clip(fieldOf(call, inputFieldOf(call.name)).replaceAll("\n", " ")),
    name: call.name,
  };
};
