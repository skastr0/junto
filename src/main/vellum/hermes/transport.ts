import { Context, Effect, Layer, Scope } from "effect";
import type { CliResult } from "../adapters/exec";
import { runCli } from "../adapters/exec";
import {
  findHostByHermesId,
  hostsWithCapability,
  sshEndpointForHermesId,
} from "../hosts/snapshot";
import {
  makeRemoteCommand,
  parseSshEndpoint,
  SshInputError,
  type SshEndpoint,
  type SshError,
} from "../ssh/domain";
import {
  dedicatedStream,
  oneShot,
  type OneShotBudget,
} from "../ssh/program";
import {
  SshTransport,
  type ConfirmSshReady,
  type SshLease,
  type SshReady,
} from "../ssh/service";
import {
  isDefaultHermesProfile,
  type HermesHostId,
  type HermesProfileName,
} from "./domain";

// Closed scripts are product policy, not caller-provided shell. Dynamic
// values cross the boundary as positional arguments after domain parsing.
const REMOTE_IDENTITY_SCRIPT = `
emit() {
  name="$1"; dir="$2"
  display=""
  for brief in "$dir/assets/identity-brief.md" "$dir/identity-brief.md"; do
    if [ -f "$brief" ]; then
      display=$(grep -m1 -E "Display name/code:" "$brief" 2>/dev/null | sed -E 's/.*Display name\\/code:[[:space:]]*//')
      [ -n "$display" ] && break
    fi
  done
  muid=""
  room=""
  env="$dir/.env"
  if [ -f "$env" ]; then
    muid=$(grep -m1 "^MATRIX_USER_ID=" "$env" 2>/dev/null | cut -d= -f2-)
    room=$(grep -m1 "^MATRIX_HOME_ROOM_NAME=" "$env" 2>/dev/null | cut -d= -f2-)
  fi
  avatar="false"
  [ -f "$dir/assets/profile-picture.png" ] && avatar="true"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$display" "$muid" "$room" "$avatar"
}
emit default "$HOME/.hermes"
if [ -d "$HOME/.hermes/profiles" ]; then
  for d in "$HOME/.hermes/profiles"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    emit "$n" "$HOME/.hermes/profiles/$n"
  done
fi
`;

const REMOTE_AVATAR_SCRIPT = `
if [ "$1" = default ]; then
  path="$HOME/.hermes/assets/profile-picture.png"
else
  path="$HOME/.hermes/profiles/$1/assets/profile-picture.png"
fi
exec base64 < "$path"
`;

const commandArgs = (
  profile: HermesProfileName,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  isDefaultHermesProfile(profile) ? args : ["-p", profile, ...args];

const describeSshFailure = (error: SshError | SshInputError): string => {
  switch (error._tag) {
    case "SshExitError":
      return `ssh operation exited with code ${error.code}`;
    case "SshTimeoutError":
      return `ssh operation timed out after ${error.timeoutMs}ms`;
    default:
      return error.message;
  }
};

/** Resolve a configured remote host by product id or hermes agent-key id. */
export const resolveHermesRemoteHost = (host: HermesHostId) =>
  findHostByHermesId(host) ??
  hostsWithCapability("hermes").find((entry) => entry.id === host);

const resolveHermesEndpoint = (
  hermesId: HermesHostId,
): Effect.Effect<SshEndpoint, SshInputError> => {
  const endpoint = sshEndpointForHermesId(hermesId);
  if (!endpoint) {
    const byId = resolveHermesRemoteHost(hermesId);
    if (!byId?.endpoint) {
      return Effect.fail(
        new SshInputError({
          message: `hermes host ${hermesId} is not a configured remote endpoint`,
        }),
      );
    }
    return parseSshEndpoint(byId.endpoint);
  }
  return parseSshEndpoint(endpoint);
};

export class HermesTransport extends Context.Tag("@vellum/HermesTransport")<
  HermesTransport,
  {
    readonly profiles: (host: HermesHostId) => Effect.Effect<CliResult>;
    readonly version: (host: HermesHostId) => Effect.Effect<CliResult>;
    readonly identityBatch: (host: HermesHostId) => Effect.Effect<CliResult>;
    readonly avatar: (
      host: HermesHostId,
      profile: HermesProfileName,
    ) => Effect.Effect<CliResult>;
    readonly connectAcp: <A, E, R>(
      host: HermesHostId,
      profile: HermesProfileName,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | SshInputError | E, R | Scope.Scope>;
  }
>() {}

export const HermesTransportLive = Layer.effect(
  HermesTransport,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;

    const local = (
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ): Effect.Effect<CliResult> =>
      Effect.tryPromise(() => runCli("hermes", args, timeoutMs)).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );

    const remoteOn = (
      endpoint: SshEndpoint,
      executable: string,
      args: ReadonlyArray<string>,
      budget: OneShotBudget,
    ): Effect.Effect<CliResult> =>
      makeRemoteCommand(executable, args).pipe(
        Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget }))),
        Effect.map((result): CliResult => ({ ok: true, stdout: result.stdout })),
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: describeSshFailure(error),
          }),
        ),
      );

    const onHost = (
      host: HermesHostId,
      args: ReadonlyArray<string>,
      budget: OneShotBudget,
      localTimeoutMs: number,
    ): Effect.Effect<CliResult> => {
      if (host === "local") return local(args, localTimeoutMs);
      const resolved = resolveHermesRemoteHost(host);
      if (!resolved || resolved.kind !== "remote" || !resolved.endpoint) {
        return Effect.succeed({
          ok: false,
          stdout: "",
          error: `unknown hermes host: ${host}`,
        });
      }
      return parseSshEndpoint(resolved.endpoint).pipe(
        Effect.flatMap((endpoint) => remoteOn(endpoint, "hermes", args, budget)),
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: describeSshFailure(error),
          }),
        ),
      );
    };

    const remoteScript = (
      host: HermesHostId,
      executable: string,
      args: ReadonlyArray<string>,
      budget: OneShotBudget,
    ): Effect.Effect<CliResult> => {
      if (host === "local") {
        return Effect.succeed({
          ok: false,
          stdout: "",
          error: "remote hermes script requires a remote host",
        });
      }
      return resolveHermesEndpoint(host).pipe(
        Effect.flatMap((endpoint) => remoteOn(endpoint, executable, args, budget)),
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: describeSshFailure(error),
          }),
        ),
      );
    };

    const connectAcp: Context.Tag.Service<typeof HermesTransport>["connectAcp"] = (
      host,
      profile,
      awaitReady,
    ) => {
      if (host === "local") {
        return Effect.fail(
          new SshInputError({
            message: "HermesTransport.connectAcp is reserved for remote hosts",
          }),
        );
      }
      return resolveHermesEndpoint(host).pipe(
        Effect.flatMap((endpoint) =>
          makeRemoteCommand("hermes", commandArgs(profile, ["acp"])).pipe(
            Effect.flatMap((command) =>
              ssh.connect(dedicatedStream(endpoint, command, "agent"), awaitReady),
            ),
          ),
        ),
      );
    };

    return HermesTransport.of({
      profiles: (host) => onHost(host, ["profile", "list"], "standard", 12_000),
      version: (host) => onHost(host, ["version"], "standard", 12_000),
      identityBatch: (host) =>
        remoteScript(
          host,
          "/bin/sh",
          ["-c", REMOTE_IDENTITY_SCRIPT, "vellum-hermes-identity"],
          "bulk",
        ),
      avatar: (host, profile) =>
        remoteScript(
          host,
          "/bin/sh",
          ["-c", REMOTE_AVATAR_SCRIPT, "vellum-hermes-avatar", profile],
          "bulk",
        ),
      connectAcp,
    });
  }),
);
