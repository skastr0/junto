import type { AuthorizedUpdateCandidate } from "./domain";
import type { InstallPlan } from "./service";
import type { UpdateHostHooks, UpdateProvider } from "./provider";

/**
 * Late-bound host hooks + install authority captured before AppRuntime
 * dispose so post-quiesce finalize can run with Effect.runPromise alone.
 */

let hostHooks: UpdateHostHooks | undefined;
let provider: UpdateProvider | undefined;
let pendingPlan: InstallPlan | undefined;
let pendingCandidate: AuthorizedUpdateCandidate | undefined;

export const installUpdateHostHooks = (hooks: UpdateHostHooks): void => {
  hostHooks = hooks;
};

export const installUpdateProviderHandle = (next: UpdateProvider): void => {
  provider = next;
};

export const requireUpdateHostHooks = (): UpdateHostHooks => {
  if (hostHooks === undefined) {
    throw new Error("update host hooks are not installed");
  }
  return hostHooks;
};

export const requireUpdateProviderHandle = (): UpdateProvider => {
  if (provider === undefined) {
    throw new Error("update provider handle is not installed");
  }
  return provider;
};

export const deferredUpdateHostHooks = (): UpdateHostHooks => ({
  quiesceForInstall: async () => {
    await requireUpdateHostHooks().quiesceForInstall();
  },
  relaunchWithoutInstall: () => {
    requireUpdateHostHooks().relaunchWithoutInstall();
  },
});

export const captureInstallAuthority = (
  plan: InstallPlan,
  candidate: AuthorizedUpdateCandidate,
): void => {
  pendingPlan = plan;
  pendingCandidate = candidate;
};

export const takeInstallAuthority = ():
  | {
      readonly plan: InstallPlan;
      readonly candidate: AuthorizedUpdateCandidate;
    }
  | undefined => {
  if (pendingPlan === undefined || pendingCandidate === undefined) {
    return undefined;
  }
  const authority = {
    plan: pendingPlan,
    candidate: pendingCandidate,
  };
  pendingPlan = undefined;
  pendingCandidate = undefined;
  return authority;
};
