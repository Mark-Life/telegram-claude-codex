import { Context } from "effect";
import type { Effect } from "effect";

import { getProvider, PROVIDER_IDS } from "./registry";
import { ONE_TURN_USES } from "./types";
import type { OneTurnUse, ProviderAvailability, ProviderId } from "./types";

/** What the host found when it last checked one provider. */
export interface ProviderSnapshot {
  /** The CLI as resolved: override, PATH, then the home bin dirs. */
  readonly bin?: string;
  /** When the check finished, epoch ms. */
  readonly checkedAt: number;
  readonly id: ProviderId;
  readonly status: ProviderAvailability;
}

/** Which provider each kind of work runs on, decided from the snapshots. */
interface ProviderRoles {
  /**
   * A route with no stored provider: new private conversations, executors,
   * and tasks while Codex cannot run.
   */
  readonly default: ProviderId;
  /** Per helper pass, the provider that serves it; absent means none can. */
  readonly helpers: Readonly<Partial<Record<OneTurnUse, ProviderId>>>;
  /** `light` runs: groups, guests, members and Business replies. */
  readonly light: ProviderId;
}

/** Snapshots by provider id. */
type ProviderSnapshots = Readonly<
  Partial<Record<ProviderId, ProviderSnapshot>>
>;

/** The roles plus the snapshot of every registered provider they came from. */
export interface EffectiveProviders extends ProviderRoles {
  readonly snapshots: ProviderSnapshots;
}

/**
 * One provider's snapshot. Every registered provider has one once the layer
 * is built; a provider never checked reads as not installed.
 */
export const snapshotOf = (
  snapshots: ProviderSnapshots,
  id: ProviderId
): ProviderSnapshot => snapshots[id] ?? { checkedAt: 0, id, status: "missing" };

/** Every registered provider's snapshot, in `PROVIDER_IDS` order. */
export const orderedSnapshots = (snapshots: ProviderSnapshots) =>
  PROVIDER_IDS.map((id) => snapshotOf(snapshots, id));

/** A provider whose CLI was found at all, whatever its account says. */
export const isInstalled = (snapshot: ProviderSnapshot) =>
  snapshot.status !== "missing";

/**
 * A provider a run may go to: `unknown` is a check that timed out, not a CLI
 * that said no, so the run goes ahead and fails on its own if it is gone.
 */
export const isRunnable = (status: ProviderAvailability) =>
  status === "ready" || status === "unknown";

/** Whether `id` has a `oneTurn` that may serve the `use` helper pass. */
export const servesOneTurn = (id: ProviderId, use: OneTurnUse) => {
  const provider = getProvider(id);
  return provider.oneTurn !== undefined && provider.oneTurnUses.includes(use);
};

/**
 * The roles, from the snapshots, in `PROVIDER_IDS` order. The default is the
 * first runnable provider (ready, or a check that timed out, so one slow
 * check at boot does not hand every route to the next provider), else the
 * first installed one, else the first registered: a run on a provider that is
 * not ready fails with the ordinary error sentence, so the type never needs a
 * "no provider" case. Light runs
 * share the default. Each helper pass goes to the first ready provider that
 * serves it, else the first one whose check gave no answer (a slow check
 * must not drop the judge, the format pass and the titles), and to none when
 * no such provider serves it.
 */
export const resolveRoles = (snapshots: ProviderSnapshots) => {
  const ordered = orderedSnapshots(snapshots);
  const ready = ordered.filter((snapshot) => snapshot.status === "ready");
  const unanswered = ordered.filter(
    (snapshot) => snapshot.status === "unknown"
  );
  const fallback =
    ordered.find(({ status }) => isRunnable(status))?.id ??
    ordered.find(isInstalled)?.id ??
    PROVIDER_IDS[0];
  const helpers: Partial<Record<OneTurnUse, ProviderId>> = {};
  for (const use of ONE_TURN_USES) {
    const helper = [...ready, ...unanswered].find(({ id }) =>
      servesOneTurn(id, use)
    );
    if (helper !== undefined) {
      helpers[use] = helper.id;
    }
  }
  const roles: ProviderRoles = { default: fallback, helpers, light: fallback };
  return roles;
};

/**
 * Which providers this host can run and which one each kind of work uses.
 * `current` is a plain read of the last snapshot, so a handler never waits on
 * a CLI. The host provides the layer: probing needs the CLI paths and the
 * operator's overrides, which only the app knows.
 */
export class Providers extends Context.Service<
  Providers,
  {
    readonly current: Effect.Effect<EffectiveProviders>;
    /**
     * Check providers again in the background. `roles: false` refreshes the
     * statuses and the helpers, which hold no session, and honours a
     * per-provider cooldown; `roles: true` (after a login) checks at once and
     * recomputes the default and light roles too.
     */
    readonly reprobe: (input: {
      readonly ids?: readonly ProviderId[];
      readonly roles: boolean;
    }) => Effect.Effect<EffectiveProviders>;
  }
>()("@workspace/agent/Providers") {}
