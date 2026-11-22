import { execSync } from "node:child_process";

/** Get the current git branch for a project directory, or null on error */
export const getCurrentBranch = (projectPath: string) => {
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
};
