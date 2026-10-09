import { Schema } from "effect";

export const HostRuntimeBlockerKind = Schema.Literals([
  "quit-app",
  "login-session",
  "disk",
  "auth",
  "unsupported",
]);
export type HostRuntimeBlockerKind = typeof HostRuntimeBlockerKind.Type;

export const HostRuntimeBlocker = Schema.Struct({
  kind: HostRuntimeBlockerKind,
  detail: Schema.String,
});
export type HostRuntimeBlocker = typeof HostRuntimeBlocker.Type;

/** One English sentence each. Deploy stops and asks the operator. */
export const HOST_RUNTIME_HARD_BLOCKER_COPY = {
  "quit-app":
    "Quit the Junto window you opened by hand, then Deploy again.",
  "login-session":
    "This machine has no login session, so Junto cannot start.",
  disk: "This machine is out of disk space.",
  auth: "This machine refused SSH — check Tailscale SSH and that this user can log in.",
} as const;

export const classifyHostRuntimeBlocker = (
  text: string,
): HostRuntimeBlocker | undefined => {
  if (/UNSUPERVISED_INCUMBENT/iu.test(text)) {
    return {
      kind: "quit-app",
      detail: HOST_RUNTIME_HARD_BLOCKER_COPY["quit-app"],
    };
  }
  if (/ENOSPC|No space left|disk full|no space left on device/iu.test(text)) {
    return { kind: "disk", detail: HOST_RUNTIME_HARD_BLOCKER_COPY.disk };
  }
  if (
    /no login session|not a login session|systemd user service is unavailable|not logged in/iu.test(
      text,
    )
  ) {
    return {
      kind: "login-session",
      detail: HOST_RUNTIME_HARD_BLOCKER_COPY["login-session"],
    };
  }
  if (
    /permission denied|publickey|Authentication failed|auth refused/iu.test(
      text,
    )
  ) {
    return { kind: "auth", detail: HOST_RUNTIME_HARD_BLOCKER_COPY.auth };
  }
  return undefined;
};

