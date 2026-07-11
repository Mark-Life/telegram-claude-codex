#!/usr/bin/env bun

import { createInterface } from "node:readline";

/** Width-1 ASCII markers per outcome (emoji render double-width and break table alignment). */
const MARK: Record<string, string> = {
  done: "+",
  errored: "x",
  timeout: "#",
  interrupted: "~",
  already_running: "-",
  at_capacity: "!",
};

const RUN_EVENT_MARKER = "telegram.run";
const SOURCE = process.env.TG_LOG_FILE ?? ".data/events.jsonl";

/** A parsed `telegram.run` wide-event. Fields are best-effort — any may be absent. */
interface RunRow {
  costUsd?: number | null;
  durationMs?: number | null;
  errorClass?: string;
  errorMessage?: string;
  outcome?: string;
  project?: string;
  provider?: string;
  totalTokens?: number | null;
  ts?: string;
  turns?: number | null;
}

/** Parse one JSONL line, returning the row only when it is a `telegram.run` event, else null. */
const parse = (line: string): RunRow | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const j = JSON.parse(trimmed);
    return j?.event === RUN_EVENT_MARKER ? (j as RunRow) : null;
  } catch {
    return null;
  }
};

/** Pad `s` to width `w`, right-aligned when `right`, truncating overflow. */
const pad = (s: string, w: number, right = false): string => {
  const v = s.length > w ? s.slice(0, w) : s;
  return right ? v.padStart(w) : v.padEnd(w);
};

/** HH:MM:SS from an ISO timestamp; falls back to the raw (clipped) value when unparseable. */
const fmtTime = (ts?: string): string => {
  if (!ts) {
    return "--:--:--";
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? pad(ts, 8) : d.toTimeString().slice(0, 8);
};

/** `$x.xxxx` or `-` when the run reported no cost (interrupt/timeout/degraded). */
const fmtCost = (n?: number | null): string =>
  typeof n === "number" ? `$${n.toFixed(4)}` : "-";

/** Human duration (`1.2s` / `340ms`) or `-`. */
const fmtDur = (ms?: number | null): string => {
  if (typeof ms !== "number") {
    return "-";
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
};

/** Integer or `-`. */
const fmtInt = (n?: number | null): string =>
  typeof n === "number" ? n.toLocaleString() : "-";

const MARK_W = 1;
const TIME_W = 8;
const COST_W = 9;
const DUR_W = 8;
const TURNS_W = 5;
const TOK_W = 9;

/** One aligned `runs` / `follow` row. */
const runLine = (r: RunRow): string => {
  const mark = MARK[r.outcome ?? ""] ?? "?";
  return [
    pad(fmtTime(r.ts), TIME_W),
    pad(mark, MARK_W),
    pad(fmtCost(r.costUsd), COST_W, true),
    pad(fmtDur(r.durationMs), DUR_W, true),
    pad(fmtInt(r.turns), TURNS_W, true),
    pad(fmtInt(r.totalTokens), TOK_W, true),
    r.project ?? "-",
  ].join(" ");
};

const RUN_HEADER = [
  pad("TIME", TIME_W),
  pad("O", MARK_W),
  pad("COST", COST_W, true),
  pad("DUR", DUR_W, true),
  pad("TURNS", TURNS_W, true),
  pad("TOKENS", TOK_W, true),
  "PROJECT",
].join(" ");

/** One aligned `errors` row: time, marker, project, errorClass, clipped errorMessage. */
const errorLine = (r: RunRow): string =>
  [
    pad(fmtTime(r.ts), TIME_W),
    pad(MARK[r.outcome ?? ""] ?? "?", MARK_W),
    pad(r.project ?? "-", 16),
    pad(r.errorClass ?? "-", 18),
    r.errorMessage ?? "-",
  ].join(" ");

const ERR_HEADER = [
  pad("TIME", TIME_W),
  pad("O", MARK_W),
  pad("PROJECT", 16),
  pad("CLASS", 18),
  "MESSAGE",
].join(" ");

/** Print aggregate counts, total cost and total wall time across all rows. */
const printStats = (rows: RunRow[]): void => {
  const counts: Record<string, number> = {};
  let totalCost = 0;
  let totalMs = 0;
  for (const r of rows) {
    const outcome = r.outcome ?? "unknown";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (typeof r.costUsd === "number") {
      totalCost += r.costUsd;
    }
    if (typeof r.durationMs === "number") {
      totalMs += r.durationMs;
    }
  }
  process.stdout.write(`runs        ${rows.length}\n`);
  for (const [outcome, n] of Object.entries(counts).sort()) {
    const mark = MARK[outcome] ?? "?";
    process.stdout.write(`  ${mark} ${pad(outcome, 16)} ${n}\n`);
  }
  process.stdout.write(`total cost  $${totalCost.toFixed(4)}\n`);
  process.stdout.write(`total wall  ${(totalMs / 1000).toFixed(1)}s\n`);
};

/** Read every line from stdin into an array of parsed run rows. */
const readStdin = (): Promise<RunRow[]> =>
  new Promise((resolve) => {
    const rows: RunRow[] = [];
    const rl = createInterface({
      input: process.stdin,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    rl.on("line", (line) => {
      const row = parse(line);
      if (row) {
        rows.push(row);
      }
    });
    rl.on("close", () => resolve(rows));
  });

/** Poll-tail the source file, printing each newly-appended `telegram.run` row. */
const runFollow = async (): Promise<void> => {
  const { stat, open } = await import("node:fs/promises");

  /** Read bytes [from, size) from the file and print any complete run rows. */
  const drain = async (from: number, size: number): Promise<number> => {
    if (size <= from) {
      return from;
    }
    const fh = await open(SOURCE, "r");
    try {
      const buf = Buffer.alloc(size - from);
      await fh.read(buf, 0, buf.length, from);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      const consumable = lastNl === -1 ? "" : text.slice(0, lastNl);
      for (const line of consumable.split("\n")) {
        const row = parse(line);
        if (row) {
          process.stdout.write(`${runLine(row)}\n`);
        }
      }
      return (
        from + Buffer.byteLength(lastNl === -1 ? "" : `${consumable}\n`, "utf8")
      );
    } finally {
      await fh.close();
    }
  };

  let offset = 0;
  try {
    offset = await drain(0, (await stat(SOURCE)).size);
  } catch {
    offset = 0;
  }

  setInterval(async () => {
    try {
      const { size } = await stat(SOURCE);
      if (size < offset) {
        offset = 0; // file truncated/rotated
      }
      offset = await drain(offset, size);
    } catch {
      // file missing or transient read error — keep polling
    }
  }, 500);
};

process.stdout.on("error", (e) => {
  if ((e as NodeJS.ErrnoException).code === "EPIPE") {
    process.exit(0);
  }
});

const mode = process.argv[2] ?? "runs";

if (mode === "follow") {
  await runFollow();
} else {
  const rows = await readStdin();
  if (mode === "errors") {
    process.stdout.write(`${ERR_HEADER}\n`);
    for (const r of rows) {
      if (r.outcome === "errored") {
        process.stdout.write(`${errorLine(r)}\n`);
      }
    }
  } else if (mode === "stats") {
    printStats(rows);
  } else {
    process.stdout.write(`${RUN_HEADER}\n`);
    for (const r of rows) {
      process.stdout.write(`${runLine(r)}\n`);
    }
  }
}
