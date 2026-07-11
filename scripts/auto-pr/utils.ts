import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { config } from "./auto-pr.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../..");
export const AUTO_PR_DIR = join(REPO_ROOT, ".auto-pr");
export const TEMPLATES_DIR = join(__dirname, "prompt-templates");

/** Matches the first Markdown H1 heading in a document */
const TITLE_RE = /^# (.+)$/m;

// ── Config types ──

export interface RepoConfig {
  /** Path within the repo this maps to (use "." for root) */
  path: string;
  /** GitHub repo in "owner/name" format */
  repo: string;
}

export interface Config {
  loopIntervalMinutes: number;
  loopRetryEnabled: boolean;
  /** Main branch name — defaults to "master" */
  mainBranch?: string;
  /** Max implementation loop iterations before giving up */
  maxImplementIterations: number;
  maxRetryDelayMs: number;
  /** Max turns per Claude CLI invocation — omit for unlimited */
  maxTurns?: number;
  /** Git remote name — defaults to "origin" */
  remote?: string;
  /** Repos to scan for issues — each maps to a path in the codebase */
  repos: RepoConfig[];
  retryDelayMs: number;
  /** Issue label that triggers the pipeline */
  triggerLabel: string;
}

// ── Resolved config (raw config + defaults + detected values) ──

export interface ResolvedConfig {
  loopIntervalMinutes: number;
  loopRetryEnabled: boolean;
  mainBranch: string;
  maxImplementIterations: number;
  maxRetryDelayMs: number;
  maxTurns?: number;
  monorepo: string;
  remote: string;
  repos: RepoConfig[];
  retryDelayMs: number;
  triggerLabel: string;
}

let _resolved: ResolvedConfig | undefined;

/** Initialize the resolved config. Detects the current repo and applies defaults. Call once at startup. */
export async function initConfig(): Promise<ResolvedConfig> {
  const monorepo = await exec("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  log(`Detected repo: ${monorepo}`);
  _resolved = {
    ...config,
    mainBranch: config.mainBranch ?? "master",
    remote: config.remote ?? "origin",
    monorepo,
  };
  return _resolved;
}

/** Get the resolved config. Throws if initConfig() hasn't been called. */
export function getConfig(): ResolvedConfig {
  if (!_resolved) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  return _resolved;
}

// ── Shell helpers ──

/** Run a command and return stdout. Throws on non-zero exit. */
async function exec(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execa(cmd, args, { cwd: REPO_ROOT });
  return stdout.trim();
}

/** Run a command, return stdout even on non-zero exit */
async function execSafe(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execa(cmd, args, { cwd: REPO_ROOT, reject: false });
  return (stdout ?? "").trim();
}

/** Run gh CLI and return parsed JSON */
export async function gh<T = unknown>(args: string[]): Promise<T> {
  const out = await exec("gh", args);
  return JSON.parse(out) as T;
}

/** Run gh CLI and return raw stdout (doesn't throw on failure) */
export function ghRaw(args: string[]): Promise<string> {
  return execSafe("gh", args);
}

/** Run git and return stdout */
export function git(args: string[]): Promise<string> {
  return exec("git", args);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Claude CLI ──

export interface ClaudeResult {
  is_error: boolean;
  num_turns: number;
  result: string;
  total_cost_usd: number;
}

/**
 * Run claude in print mode. Collects JSON output and returns parsed result.
 */
export async function runClaude(opts: {
  promptFile: string;
  permissionMode: "plan" | "acceptEdits";
  maxTurns?: number;
  retry?: boolean;
}): Promise<ClaudeResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    opts.permissionMode,
    ...(opts.maxTurns ? ["--max-turns", String(opts.maxTurns)] : []),
    `@${opts.promptFile}`,
  ];

  const cfg = getConfig();
  let retryDelay = cfg.retryDelayMs;

  while (true) {
    try {
      const { stdout } = await execa("claude", args, {
        cwd: REPO_ROOT,
        stdin: "ignore",
        stderr: "inherit",
      });

      try {
        const result = JSON.parse(stdout) as ClaudeResult;
        log(
          `Done — $${result.total_cost_usd.toFixed(4)} | ${result.num_turns} turns`
        );
        if (result.result) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(result.result);
          console.log(`${"─".repeat(60)}\n`);
        }
        return result;
      } catch {
        log("Done — failed to parse Claude output");
        if (stdout.trim()) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(stdout.trim());
          console.log(`${"─".repeat(60)}\n`);
        }
        return {
          result: stdout.trim(),
          is_error: false,
          total_cost_usd: 0,
          num_turns: 0,
        };
      }
    } catch (e) {
      const shouldRetry = opts.retry ?? cfg.loopRetryEnabled ?? false;
      if (!shouldRetry) {
        throw e;
      }

      log(`Claude process error: ${e}`);
      log(`Retrying in ${retryDelay / 1000}s...`);
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, cfg.maxRetryDelayMs);
    }
  }
}

// ── Template resolution ──

export interface TokenValues {
  ISSUE_DIR: string;
  MAIN_BRANCH: string;
  SCOPE_PATH: string;
}

/**
 * Load a prompt template, replace {{TOKENS}}, save resolved prompt to issue dir.
 * Returns the relative path (from monorepo root) to the saved prompt file.
 */
export function resolveTemplate(
  templateName: string,
  tokens: TokenValues,
  issueDir: string
): string {
  const templatePath = join(TEMPLATES_DIR, templateName);
  let template = readFileSync(templatePath, "utf-8");

  for (const [key, value] of Object.entries(tokens)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  // Save resolved prompt — claude will be invoked with @path to this file
  const resolvedPath = join(issueDir, templateName);
  ensureDir(dirname(resolvedPath));
  writeFileSync(resolvedPath, template, "utf-8");

  return relative(REPO_ROOT, resolvedPath);
}

// ── File helpers ──

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

export function writeFile(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf-8");
}

// ── Git helpers ──

/** Stage and commit .auto-pr artifacts for the current issue. No-op if nothing to commit. */
export async function commitArtifacts(
  ctx: IssueContext,
  message: string
): Promise<void> {
  await git(["add", ctx.issueDirRel]);
  const staged = await execSafe("git", ["diff", "--cached", "--name-only"]);
  if (staged.length > 0) {
    await git(["commit", "-m", message]);
  }
}

// ── Issue context ──

export interface IssueContext {
  body: string;
  branch: string; // e.g. "auto-pr/boa-studio/issue-42"
  issueDir: string; // absolute path to .auto-pr/{repoShort}/issue-{N}
  issueDirRel: string; // relative path from monorepo root
  number: number;
  repo: string; // e.g. "owner/my-repo"
  repoShort: string; // e.g. "my-repo"
  scopePath: string; // e.g. "apps/my-app" or "."
  title: string;
}

export function repoShortName(repo: string): string {
  return repo.split("/").at(-1) ?? repo;
}

export function buildIssueContext(
  issue: { number: number; title: string; body: string },
  repo: string,
  scopePath: string
): IssueContext {
  const repoShort = repoShortName(repo);
  const issueDirRel = `.auto-pr/${repoShort}/issue-${issue.number}`;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    repo,
    repoShort,
    scopePath,
    issueDir: join(REPO_ROOT, issueDirRel),
    issueDirRel,
    branch: `auto-pr/${repoShort}/issue-${issue.number}`,
  };
}

export function buildTokens(ctx: IssueContext): TokenValues {
  return {
    SCOPE_PATH: ctx.scopePath,
    ISSUE_DIR: ctx.issueDirRel,
    MAIN_BRANCH: getConfig().mainBranch,
  };
}

export function log(msg: string): void {
  console.log(`[auto-pr] ${msg}`);
}

export function logStep(
  step: string,
  ctx: IssueContext,
  skipped = false
): void {
  const tag = skipped ? "SKIP" : "RUN";
  console.log(`\n${"═".repeat(60)}`);
  console.log(`[${tag}] ${step} — ${ctx.repo}#${ctx.number} (${ctx.title})`);
  console.log(`${"═".repeat(60)}\n`);
}

export function buildContextFromArtifacts(
  issueNumber: number,
  repoShort: string
): IssueContext {
  const repoConfig = getConfig().repos.find(
    (r) => repoShortName(r.repo) === repoShort
  );
  if (!repoConfig) {
    throw new Error(`Unknown repo: ${repoShort}`);
  }

  const issueDirRel = `.auto-pr/${repoShort}/issue-${issueNumber}`;
  const issueDir = join(REPO_ROOT, issueDirRel);
  const ramblingsPath = join(issueDir, "initial-ramblings.md");

  if (!existsSync(ramblingsPath)) {
    throw new Error(
      `No artifacts found at ${issueDirRel}. Run the pipeline first.`
    );
  }

  const content = readFileSync(ramblingsPath, "utf-8");
  const titleMatch = content.match(TITLE_RE);
  const title = titleMatch?.[1] ?? `Issue #${issueNumber}`;

  const lines = content.split("\n");
  let blankCount = 0;
  let bodyStartIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === "") {
      blankCount++;
      if (blankCount === 2) {
        bodyStartIndex = i + 1;
        break;
      }
    }
  }
  const body = lines.slice(bodyStartIndex).join("\n").trim();

  return buildIssueContext(
    { number: issueNumber, title, body },
    repoConfig.repo,
    repoConfig.path
  );
}
