import { ProviderCrashed } from "./errors";
import { runsInView } from "./sandbox/host";
import type { ProviderWiring, RunAccess, SandboxMode } from "./types";

const narrowSandbox = (
  sandbox: SandboxMode,
  postures: readonly SandboxMode[]
): SandboxMode =>
  sandbox === "read-only" && !postures.includes(sandbox) ? "none" : sandbox;

/**
 * Fit a run's access to what its provider can enforce and wire on this host.
 * It only ever takes away: a tool the provider cannot wire is dropped, a
 * `read-only` posture it cannot enforce becomes `none`, no local tools at all,
 * and a run inside the bwrap view of a provider that keeps no session there
 * keeps none. `workspace-write` and full access are never narrowed silently;
 * a provider that lacks them fails the run in `assertPosture` instead. The
 * prompt is built from the narrowed record, so a run is never told about a
 * tool it does not have.
 */
export const narrowAccess = (
  access: RunAccess,
  caps: ProviderWiring
): RunAccess => {
  const sandbox = narrowSandbox(access.sandbox, caps.postures);
  return {
    ...access,
    externalTools: access.externalTools && caps.externalTools,
    groupMemory: caps.groupMemory ? access.groupMemory : "none",
    persistSession:
      access.persistSession && (caps.sessionsInView || !runsInView(sandbox)),
    sandbox,
    telegramAccount: access.telegramAccount && caps.telegramAccount,
  };
};

/**
 * Whether the provider can run `access` at all once it is narrowed: `read-only`
 * it cannot enforce becomes `none`, so only `workspace-write` or full access
 * it lacks refuses.
 */
export const canRun = (
  caps: Pick<ProviderWiring, "postures">,
  access: Pick<RunAccess, "sandbox">
) => caps.postures.includes(narrowSandbox(access.sandbox, caps.postures));

/**
 * A provider's last check before it spawns anything: the posture it was
 * handed is one it enforces. A mismatch fails the run with `ProviderCrashed`
 * rather than starting it with more privilege than it was given.
 */
export const assertPosture = (
  caps: Pick<ProviderWiring, "postures">,
  access: Pick<RunAccess, "sandbox">
) => {
  if (!caps.postures.includes(access.sandbox)) {
    throw new ProviderCrashed({
      message: `The provider cannot enforce the ${access.sandbox} sandbox posture`,
    });
  }
};
