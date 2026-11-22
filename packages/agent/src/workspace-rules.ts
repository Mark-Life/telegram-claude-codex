import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The user's rules files as text a run is told inline, for a provider whose
 * CLI loads no instruction file of its own in a bot run (Claude with
 * `settingSources: []`, pi with discovery off). A line that is only
 * `@<path>` is replaced by that file, as Claude Code's own `CLAUDE.md`
 * imports are: absolute, `~/`, or relative to the file that names it.
 */

/** How deep imports nest: a file, its import, and that one's import. */
const MAX_DEPTH = 3;

/** All rules together, imports included, in characters. */
export const MAX_RULES_CHARS = 40_000;

const IMPORT_LINE = /^\s*@(?<target>\S+)\s*$/u;
const BLANK_LINES = /\n\s*\n/gu;

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
};

const realPath = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/** Where an import points, from the file that names it. */
const resolveImport = (target: string, from: string) => {
  if (target === "~" || target.startsWith("~/")) {
    return path.join(homedir(), target.slice(1));
  }
  return path.resolve(path.dirname(from), target);
};

/**
 * One file's text with its imports in place. `chain` is the files that led
 * here, so a file that imports itself, directly or not, stops there.
 */
const expandFile = (input: {
  chain: readonly string[];
  file: string;
  text: string;
}): string =>
  input.text
    .split("\n")
    .map((line) => {
      const target = IMPORT_LINE.exec(line)?.groups?.target;
      if (target === undefined) {
        return line;
      }
      const file = resolveImport(target, input.file);
      const real = realPath(file);
      if (input.chain.includes(real)) {
        return `(${file}: already included above)`;
      }
      if (input.chain.length >= MAX_DEPTH) {
        return `(${file}: not included, imports nest too deep)`;
      }
      const text = readText(file);
      if (text === undefined) {
        // Kept as written: it may be a handle, not a path.
        return `${line} (no file ${file})`;
      }
      const body = expandFile({ chain: [...input.chain, real], file, text });
      return `<file path="${file}">\n${body.trim()}\n</file>`;
    })
    .join("\n");

/**
 * Every rules file that exists, each in a `<rules>` section with its imports
 * expanded, as one paragraph: blank lines are dropped, so the block stays a
 * single paragraph of the prompt (`splitRunPrompt`). Over `MAX_RULES_CHARS`
 * the rest is cut with a note. Empty when no file exists. Read on every
 * call, so an edit shows on the next turn.
 */
export const inlineRules = (files: readonly string[]) => {
  const sections = files.flatMap((file) => {
    const text = readText(file);
    if (text === undefined) {
      return [];
    }
    const body = expandFile({ chain: [realPath(file)], file, text });
    return [`<rules file="${file}">\n${body.trim()}\n</rules>`];
  });
  const all = sections.join("\n").replaceAll(BLANK_LINES, "\n");
  return all.length <= MAX_RULES_CHARS
    ? all
    : `${all.slice(0, MAX_RULES_CHARS)}\n(cut: the rules files are over ${MAX_RULES_CHARS} characters; read the rest from the files)`;
};
