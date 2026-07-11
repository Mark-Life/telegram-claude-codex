import { join } from "node:path";
import { stepCreatePR } from "./steps/create-pr.js";
import { stepImplement } from "./steps/implement.js";
import { stepPlan } from "./steps/plan.js";
import { stepPlanAnnotations } from "./steps/plan-annotations.js";
import { stepPlanImplementation } from "./steps/plan-implementation.js";
import { stepRemoveLabel } from "./steps/remove-label.js";
import { stepResearch } from "./steps/research.js";
import { stepReview } from "./steps/review.js";
import {
  ensureDir,
  fileExists,
  getConfig,
  git,
  type IssueContext,
  log,
  writeFile,
} from "./utils.js";

const STEPS = [
  { name: "research", run: stepResearch },
  { name: "plan", run: stepPlan },
  { name: "plan-annotations", run: stepPlanAnnotations },
  { name: "plan-implementation", run: stepPlanImplementation },
  { name: "implement", run: stepImplement },
  { name: "review", run: stepReview },
  { name: "create-pr", run: stepCreatePR },
  { name: "remove-label", run: stepRemoveLabel },
] as const;

export type StepName = (typeof STEPS)[number]["name"];

export const STEP_NAMES = STEPS.map((s) => s.name);

/**
 * Checkout the main branch as best-effort cleanup so a failed or paused
 * pipeline never leaves the repo parked on a feature branch. Failures
 * (dirty tree, missing branch) are intentionally ignored.
 */
const returnToMain = () =>
  git(["checkout", getConfig().mainBranch]).catch(() => {
    /* best-effort cleanup; ignore if the checkout fails */
  });

/**
 * Run the pipeline for a single issue, starting from whatever step is needed.
 * If `untilStep` is provided, stop after that step completes.
 */
export async function runPipeline(
  ctx: IssueContext,
  untilStep?: StepName
): Promise<void> {
  log(`Pipeline starting for ${ctx.repo}#${ctx.number}: ${ctx.title}`);

  // Checkout the branch first (if it exists) so we see any previously committed artifacts
  try {
    const branches = await git(["branch", "--list", ctx.branch]);
    const shortName = ctx.branch.split("/").at(-1) ?? ctx.branch;
    if (branches.includes(shortName)) {
      await git(["checkout", ctx.branch]);
    }
  } catch {
    /* may not exist yet, research step will create it */
  }

  // Save initial-ramblings.md for this issue (idempotent — skips if already on branch from prior run)
  ensureDir(ctx.issueDir);
  const ramblingsPath = join(ctx.issueDir, "initial-ramblings.md");
  if (!fileExists(ramblingsPath)) {
    const content = `# ${ctx.title}\n\n> ${ctx.repo}#${ctx.number}\n\n${ctx.body ?? ""}`;
    writeFile(ramblingsPath, content);
    log("Saved initial-ramblings.md");
  }

  for (const step of STEPS) {
    const success = await step.run(ctx);

    if (!success) {
      log(`Pipeline stopped at "${step.name}" for ${ctx.repo}#${ctx.number}`);
      // Return to main so we don't leave the repo on a feature branch
      await returnToMain();
      return;
    }

    if (untilStep && step.name === untilStep) {
      log(`Pipeline paused after "${step.name}" (--until ${untilStep})`);
      await returnToMain();
      return;
    }
  }

  log(`Pipeline complete for ${ctx.repo}#${ctx.number}`);
  // Return to main
  await returnToMain();
}
