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
    await git(["checkout", cfg.mainBranch]).catch(() => {});
  }
  const status = await git(["status", "--porcelain"]);
  if (status.length > 0) {
    log("Warning: working tree has uncommitted changes, stashing...");
    await git(["stash"]).catch(() => {});
  }
  await git(["pull", cfg.remote, cfg.mainBranch]);
}

function registerShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`Received ${signal}, shutting down...`);
      git(["checkout", getConfig().mainBranch])
        .catch(() => {})
        .then(() => process.exit(0));
    });
  }
}

async function main() {
  const cfg = await initConfig();
  const defaultRepoShort = repoShortName(cfg.repos[0]?.repo ?? "");

  // Handle --reset (local-only)
  if (values.reset) {
    const issueNum = values.reset;
    const repoShort = values.repo ?? defaultRepoShort;
    const issueDir = join(REPO_ROOT, `.auto-pr/${repoShort}/issue-${issueNum}`);
    log(`Resetting state for ${repoShort}/issue-${issueNum}...`);
    rmSync(issueDir, { recursive: true, force: true });
    log(`Cleaned ${issueDir}`);
    return;
  }

  // Handle --refresh
  if (values.refresh) {
    const { stepRefresh } = await import("./steps/refresh.js");
    const { buildIssueContext, repoShortName: rsn } = await import(
      "./utils.js"
    );
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
    return;
  }

  // Validate --until
  const untilStep = values.until as StepName | undefined;
  if (untilStep && !STEP_NAMES.includes(untilStep)) {
    console.error(
      `Invalid step "${untilStep}". Valid steps: ${STEP_NAMES.join(", ")}`
    );
    process.exit(1);
  }

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
  let iteration = 0;

  do {
    const iterationStart = Date.now();
    iteration++;

    if (loopMode) {
      console.log(`\n${"─".repeat(60)}`);
      log(`Iteration #${iteration} — ${new Date().toISOString()}`);
      console.log(`${"─".repeat(60)}\n`);
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

    // --issue N: fetch directly by number (no label filter needed)
    // Otherwise: scan all repos for labeled issues
    let contexts: Awaited<ReturnType<typeof fetchIssues>>;
    if (filterIssue) {
      const ctx = await fetchIssue(
        filterIssue,
        values.repo as string | undefined
      );
      contexts = ctx ? [ctx] : [];
    } else {
      contexts = await fetchIssues(limit);
    }

    if (contexts.length === 0) {
      log("No issues to process.");
    } else {
      log(`Processing ${contexts.length} issue(s)...\n`);

      for (const ctx of contexts) {
        try {
          await runPipeline(ctx, untilStep);
        } catch (e) {
          console.error(`Pipeline error for ${ctx.repo}#${ctx.number}:`, e);
        }
      }
    }

    if (loopMode) {
      const waitMs = Math.max(0, intervalMs - (Date.now() - iterationStart));
      if (waitMs > 0) {
        log(`Waiting ${Math.round(waitMs / 1000)}s until next iteration...`);
        await sleep(waitMs);
      }
    }
  } while (loopMode);

  log("Done.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
