import {
  canRun,
  getProvider,
  isInstalled,
  isRunnable,
  narrowAccess,
  snapshotOf,
} from "@workspace/agent";
import type { RunAccess } from "@workspace/agent/types";
import { Effect } from "effect";

import {
  effectiveProviders,
  reprobeInBackground,
} from "../handlers/agent-bridge";
import type { ProviderRoute } from "../handlers/route-provider";
import { t } from "../i18n";
import { runtime } from "../runtime";
import { providerOffered } from "../telegram/commands";
import type { Tier } from "./tier";

/**
 * Whether a run may start on the provider its route named. A stored choice —
 * a topic's row, the owner's own pick — is never swapped for another provider:
 * that would start a second conversation and, in a topic, wipe the stored
 * session and pick. When it cannot run, the run is refused with one sentence
 * instead, and the provider is checked again in the background so the next
 * message sees a login fixed in the shell. A route nobody chose takes the
 * detected default as it is; a run there that cannot work fails with the
 * ordinary error sentence.
 *
 * A run whose posture the provider cannot enforce on this host is refused
 * too: a member's `workspace-write` is never narrowed to something else. An
 * allowed run gets its access back with the session it may keep there: none
 * inside the bwrap view of a provider that keeps no session in it.
 */

type ProviderVerdict =
  | { access: RunAccess; allowed: true; route: ProviderRoute }
  | { allowed: false; reply: string };

/**
 * What the owner can do about it, as far as this host offers a way. A CLI
 * that is gone does not come back by itself, so while another provider is
 * ready the owner is sent to /provider even when the menu does not list it.
 */
const ownerHint = (route: ProviderRoute) => {
  const providers = effectiveProviders();
  if (providerOffered(providers)) {
    return t().provider.hint.switchOrWait;
  }
  const snapshot = snapshotOf(providers.snapshots, route.provider);
  const otherReady =
    providers.default !== route.provider &&
    snapshotOf(providers.snapshots, providers.default).status === "ready";
  if (!isInstalled(snapshot) && otherReady) {
    return t().provider.hint.switch;
  }
  const provider = getProvider(route.provider);
  // Waiting never fixes a logout, and this provider has no /login of its own.
  if (snapshot.status === "logged_out" && provider.deviceLogin === undefined) {
    return t().provider.hint.loginOnServer(provider.displayName);
  }
  const loginHere = provider.deviceLogin !== undefined && isInstalled(snapshot);
  return loginHere ? t().provider.hint.loginOrWait : t().provider.hint.wait;
};

const refusalCopy = (route: ProviderRoute, tier: Tier) => {
  const name = getProvider(route.provider).displayName;
  return tier === "owner"
    ? `${t().provider.unavailable(name)} ${ownerHint(route)}`
    : t().provider.topicUnavailable(name);
};

/** The access with the session the provider can keep for it on this host. */
export const fitSession = (route: ProviderRoute, access: RunAccess) => ({
  ...access,
  persistSession: narrowAccess(access, getProvider(route.provider).capabilities)
    .persistSession,
});

/** Whether a stored route's provider is down; logs and re-checks it if so. */
const storedDown = (route: ProviderRoute) => {
  if (route.source !== "owner" && route.source !== "topic") {
    return false;
  }
  const { status } = snapshotOf(effectiveProviders().snapshots, route.provider);
  if (isRunnable(status)) {
    return false;
  }
  runtime.runFork(
    Effect.logWarning("provider.refused").pipe(
      Effect.annotateLogs({
        requested: route.provider,
        source: route.source,
        status,
      })
    )
  );
  reprobeInBackground([route.provider]);
  return true;
};

/** Allow the route's provider, or refuse a run it cannot serve now. */
export const providerFor = (input: {
  access: RunAccess;
  route: ProviderRoute;
  tier: Tier;
}): ProviderVerdict => {
  const { access, route } = input;
  if (storedDown(route)) {
    return { allowed: false, reply: refusalCopy(route, input.tier) };
  }
  if (!canRun(getProvider(route.provider).capabilities, access)) {
    runtime.runFork(
      Effect.logWarning("provider.posture_refused").pipe(
        Effect.annotateLogs({
          provider: route.provider,
          sandbox: access.sandbox,
        })
      )
    );
    // A fact of this host, so the reply promises no retry.
    return { allowed: false, reply: t().provider.noFiles };
  }
  return { access: fitSession(route, access), allowed: true, route };
};
