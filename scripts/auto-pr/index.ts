import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runPipeline, STEP_NAMES, type StepName } from "./pipeline.js";
import { fetchIssue, fetchIssues } from "./steps/fetch-issues.js";
import {
  getConfig,
  git,
  initConfig,
  log,
  REPO_ROOT,
  repoShortName,
  sleep,
} from "./utils.js";

const { values } = parseArgs({
  options: {
    issue: { type: "string", short: "i" },
    until: { type: "string", short: "u" },
    reset: { type: "string" },
    refresh: { type: "boolean" },
    repo: { type: "string", short: "r" },
    help: { type: "boolean", short: "h" },
    once: { type: "boolean" },
    interval: { type: "string" },
    limit: { type: "string" },
  },
  strict: false,
});

if (values.help) {
  console.log(`
auto-pr — Automated issue-to-PR pipeline

Polls GitHub for issues labeled "auto-pr", runs each through a multi-step
Claude pipeline (research → plan → implement → review), and opens a PR.

Usage:
  bun auto-pr                                   Start the loop (default)
  bun auto-pr -- --once                         Run one iteration then exit
  bun auto-pr -- --issue 42                     Process a specific issue (implies --once)
  bun auto-pr -- --issue 42 --repo my-repo      Specify which repo the issue belongs to
  bun auto-pr -- --issue 42 --until plan        Stop after a specific step (implies --once)
  bun auto-pr -- --reset 42                     Delete local state for an issue (force restart)
  bun auto-pr -- --reset 42 --repo my-repo      Reset a specific repo's issue
  bun auto-pr -- --refresh --issue 42           Rebase a stale PR branch onto current main
  bun auto-pr -- --interval 45                  Poll interval in minutes (default: 15)
  bun auto-pr -- --limit 3                      Max issues per iteration (default: 1)

Steps: ${STEP_NAMES.join(" → ")}
`);
  process.exit(0);
}

async function syncWithRemote() {
  const cfg = getConfig();
  log("Syncing with remote...");
  await git(["fetch", "--all", "--prune"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== cfg.mainBranch) {
    log(`Warning: on branch "${branch}", switching to ${cfg.mainBranch}...`);
    await git(["checkout", cfg.mainBranch]).catch(() => {
      /* checkout may fail on a dirty tree; stash + pull below recover */
    });
  }
  const status = await git(["status", "--porcelain"]);
  if (status.length > 0) {
    log("Warning: working tree has uncommitted changes, stashing...");
    await git(["stash"]).catch(() => {
      /* nothing to stash (or stash unavailable); proceed to pull */
    });
  }
  await git(["pull", cfg.remote, cfg.mainBranch]);
}

function registerShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`Received ${signal}, shutting down...`);
      git(["checkout", getConfig().mainBranch])
        .catch(() => {
          /* best-effort return to main; exit regardless of outcome */
        })
        .then(() => process.exit(0));
    });
  }
}

type Config = Awaited<ReturnType<typeof initConfig>>;
type IssueContexts = Awaited<ReturnType<typeof fetchIssues>>;

/** Delete local pipeline state for an issue so it restarts from scratch. */
const handleReset = (defaultRepoShort: string) => {
  const issueNum = values.reset;
  const repoShort = values.repo ?? defaultRepoShort;
  const issueDir = join(REPO_ROOT, `.auto-pr/${repoShort}/issue-${issueNum}`);
  log(`Resetting state for ${repoShort}/issue-${issueNum}...`);
  rmSync(issueDir, { recursive: true, force: true });
  log(`Cleaned ${issueDir}`);
};

/** Rebase a stale PR branch onto current main for a single --issue. */
const handleRefresh = async (cfg: Config, defaultRepoShort: string) => {
  const { stepRefresh } = await import("./steps/refresh.js");
  const { buildIssueContext, repoShortName: rsn } = await import("./utils.js");
  if (!values.issue) {
    throw new Error("--refresh requires --issue <number>");
  }
  const issueNum = Number(values.issue);
  const repoShort = values.repo ?? defaultRepoShort;
  const repoConfig = cfg.repos.find((r) => rsn(r.repo) === repoShort);
  if (!repoConfig) {
    throw new Error(`Unknown repo: ${repoShort}`);
  }
  const ctx = buildIssueContext(
    { number: issueNum, title: `Issue #${issueNum}`, body: "" },
    repoConfig.repo,
    repoConfig.path
  );
  await stepRefresh(ctx);
};

/** Validate the --until flag, exiting the process on an unknown step. */
const resolveUntilStep = () => {
  const untilStep = values.until as StepName | undefined;
  if (untilStep && !STEP_NAMES.includes(untilStep)) {
    console.error(
      `Invalid step "${untilStep}". Valid steps: ${STEP_NAMES.join(", ")}`
    );
    process.exit(1);
  }
  return untilStep;
};

/** Resolve the issue contexts to process: a single --issue or a labeled scan. */
const fetchContexts = async (
  filterIssue: number | undefined,
  limit: number
): Promise<IssueContexts> => {
  if (filterIssue) {
    const ctx = await fetchIssue(
      filterIssue,
      values.repo as string | undefined
    );
    return ctx ? [ctx] : [];
  }
  return await fetchIssues(limit);
};

/** Run the pipeline for each context, logging per-issue failures. */
const processContexts = async (
  contexts: IssueContexts,
  untilStep: StepName | undefined
) => {
  if (contexts.length === 0) {
    log("No issues to process.");
    return;
  }
  log(`Processing ${contexts.length} issue(s)...\n`);
  for (const ctx of contexts) {
    try {
      await runPipeline(ctx, untilStep);
    } catch (e) {
      console.error(`Pipeline error for ${ctx.repo}#${ctx.number}:`, e);
    }
  }
};

/** Print the iteration banner shown in loop mode. */
const logIterationHeader = (iteration: number) => {
  console.log(`\n${"─".repeat(60)}`);
  log(`Iteration #${iteration} — ${new Date().toISOString()}`);
  console.log(`${"─".repeat(60)}\n`);
};

/** Sleep off the time remaining until the next scheduled iteration. */
const waitForNextIteration = async (
  iterationStart: number,
  intervalMs: number
) => {
  const waitMs = Math.max(0, intervalMs - (Date.now() - iterationStart));
  if (waitMs > 0) {
    log(`Waiting ${Math.round(waitMs / 1000)}s until next iteration...`);
    await sleep(waitMs);
  }
};

interface LoopParams {
  filterIssue: number | undefined;
  intervalMs: number;
  limit: number;
  loopMode: boolean;
  untilStep: StepName | undefined;
}

/** Drive the poll loop: sync, fetch, and process issues until done. */
const runLoop = async ({
  loopMode,
  intervalMs,
  limit,
  filterIssue,
  untilStep,
}: LoopParams) => {
  let iteration = 0;

  do {
    const iterationStart = Date.now();
    iteration++;

    if (loopMode) {
      logIterationHeader(iteration);
    }

    try {
      await syncWithRemote();
    } catch (e) {
      log(`Sync failed: ${e instanceof Error ? e.message : e}`);
      if (loopMode) {
        log(`Will retry in ${Math.round(intervalMs / 1000)}s...`);
        await sleep(intervalMs);
        continue;
      }
      throw e;
    }

    const contexts = await fetchContexts(filterIssue, limit);
    await processContexts(contexts, untilStep);

    if (loopMode) {
      await waitForNextIteration(iterationStart, intervalMs);
    }
  } while (loopMode);
};

async function main() {
  const cfg = await initConfig();
  const defaultRepoShort = repoShortName(cfg.repos[0]?.repo ?? "");

  if (values.reset) {
    handleReset(defaultRepoShort);
    return;
  }

  if (values.refresh) {
    await handleRefresh(cfg, defaultRepoShort);
    return;
  }

  const untilStep = resolveUntilStep();

  // --issue or --until implies single run (--once)
  const singleRun = values.once || !!values.issue || !!untilStep;
  const loopMode = !singleRun;
  const intervalMs =
    (Number(values.interval) || cfg.loopIntervalMinutes) * 60_000;
  const limit = values.limit ? Number(values.limit) : 1;

  if (loopMode) {
    cfg.loopRetryEnabled = true;
    registerShutdownHandlers();
    log(`Loop mode — interval: ${intervalMs / 60_000}min, limit: ${limit}`);
  }

  const filterIssue = values.issue ? Number(values.issue) : undefined;
  await runLoop({ loopMode, intervalMs, limit, filterIssue, untilStep });

  log("Done.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
