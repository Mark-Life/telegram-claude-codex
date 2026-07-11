import { execSync } from "node:child_process";

const MAX_BRANCHES = 50;

const SSH_REMOTE_RE = /^git@([^:]+):(.+?)(?:\.git)?$/;
const GIT_SUFFIX_RE = /\.git$/;

/** Get GitHub HTTPS URL for a project directory, or null if unavailable */
export function getGitHubUrl(projectPath: string) {
  try {
    const raw = execSync("git remote get-url origin", {
      cwd: projectPath,
      timeout: 3000,
    })
      .toString()
      .trim();
    // SSH: git@github.com:user/repo.git -> https://github.com/user/repo
    const sshMatch = raw.match(SSH_REMOTE_RE);
    if (sshMatch) {
      return `https://${sshMatch[1]}/${sshMatch[2]}`;
    }
    // HTTPS: strip trailing .git
    try {
      const url = new URL(raw);
      url.pathname = url.pathname.replace(GIT_SUFFIX_RE, "");
      return url.toString();
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** Get the current git branch for a project directory, or null on error */
export function getCurrentBranch(projectPath: string) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectPath,
      timeout: 3000,
    })
      .toString()
      .trim();
    return branch === "HEAD" ? "(detached)" : branch;
  } catch {
    return null;
  }
}

/** List local branch names for a project directory (capped at MAX_BRANCHES), or null on error */
export function listBranches(projectPath: string) {
  try {
    const output = execSync(
      "git branch --format='%(refname:short)' --sort=-committerdate",
      { cwd: projectPath, timeout: 5000 }
    )
      .toString()
      .trim();
    return output
      ? output
          .split("\n")
          .map((b) => b.trim())
          .slice(0, MAX_BRANCHES)
      : [];
  } catch {
    return null;
  }
}

/** List open PRs for a project directory via gh CLI, or null on error */
export function listOpenPRs(projectPath: string) {
  try {
    const output = execSync(
      "gh pr list --state open --json number,title,headRefName,url --limit 10",
      {
        cwd: projectPath,
        timeout: 10_000,
      }
    )
      .toString()
      .trim();
    return JSON.parse(output) as {
      number: number;
      title: string;
      headRefName: string;
      url: string;
    }[];
  } catch {
    return null;
  }
}
