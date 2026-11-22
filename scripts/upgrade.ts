import { $ } from "bun";

const SEPARATOR_WIDTH = 50;

const WORKSPACES = [
  "apps/web",
  "packages/api",
  "packages/env",
  "packages/ui",
  "scripts",
  "tools/oxlint/anti-slop",
] as const;

/**
 * TypeScript 7 is the native port. It ships no JS compiler API, so Next.js shells
 * out to the project-local `tsc` instead (`experimental.useTypeScriptCli`, on by
 * default since Next 16.3). Keep Next at >=16.3 for as long as this stays on 7.x.
 *
 * Bumping this major is a breaking change, not a version bump: re-read the release
 * notes for removed compiler options before changing it.
 */
const TYPESCRIPT_MAJOR = "7";

/**
 * `bun add --exact` records the spec it was handed, so a bare major would pin the
 * literal `"7"` and quietly break the exact-pin convention. Resolve it first.
 */
const typescriptVersionOutput =
  await $`bun info typescript@${TYPESCRIPT_MAJOR} version`.text();
const typescriptVersion = typescriptVersionOutput.trim();

/** Expand a shell command into one step per workspace. */
const perWorkspace = (
  label: string,
  command: (workspace: string) => ReturnType<typeof $>
) =>
  WORKSPACES.map((workspace) => ({
    command: () => command(workspace).cwd(workspace),
    critical: true,
    name: `${label}: ${workspace}`,
  }));

const steps = [
  {
    /**
     * `@oxlint/plugins` ships in lockstep with `oxlint`: the JS plugin API is not
     * stable across versions. `tsrs` is both the type checker and the backend
     * Oxlint uses for type-aware rules, so it moves with them.
     */
    command: () =>
      $`bun add -D --exact oxlint@latest @oxlint/plugins@latest tsrs@latest oxfmt@latest typescript@${typescriptVersion} ultracite@latest`,
    critical: true,
    name: `Bump root dev tooling (TypeScript ${typescriptVersion})`,
  },
  {
    command: () => $`bun update --latest`,
    critical: true,
    name: "Bump root dependencies",
  },
  ...perWorkspace("Bump dependencies", () => $`bun update --latest`),
  {
    command: () => $`bunx @next/codemod@latest upgrade`.cwd("apps/web"),
    critical: true,
    name: "Next.js Upgrade",
  },
  {
    command: () =>
      $`bunx shadcn@latest add --all --overwrite`.cwd("packages/ui"),
    critical: true,
    name: "shadcn/ui Components",
  },
  {
    command: () => $`bun install`,
    critical: true,
    name: "Install",
  },
  {
    command: () => $`bun run fix`,
    critical: false,
    name: "Ultracite Fix",
  },
  {
    command: () => $`bun run typecheck`,
    critical: false,
    name: "Type Check",
  },
  {
    command: () => $`bun run build`,
    critical: false,
    name: "Build",
  },
] as const;

let failed = false;

for (const step of steps) {
  console.log(`\n${"=".repeat(SEPARATOR_WIDTH)}`);
  console.log(`>> ${step.name}`);
  console.log("=".repeat(SEPARATOR_WIDTH));

  // oxlint-disable-next-line no-await-in-loop -- each step mutates the repo and must finish before the next starts
  const result = await step.command().nothrow();

  if (result.exitCode === 0) {
    console.log(`\n✓ ${step.name} completed`);
  } else {
    console.error(`\n!! ${step.name} failed (exit code ${result.exitCode})`);

    if (step.critical) {
      console.error("Critical step failed, aborting.");
      process.exit(1);
    }

    failed = true;
    console.warn("Non-critical failure, continuing...");
  }
}

if (failed) {
  console.warn("\nUpgrade completed with warnings.");
  process.exit(1);
}

console.log("\nUpgrade completed successfully.");
