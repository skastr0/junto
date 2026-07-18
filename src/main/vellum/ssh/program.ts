import * as Command from "@effect/platform/Command";
import type { SshEndpoint, UnixSocketPath, RemoteCommand } from "./domain";
import { inspectRemoteCommand } from "./domain";

export type OneShotBudget = "short" | "status" | "list" | "standard";
export type ReadinessBudget = "fast" | "agent";

export const ONE_SHOT_TIMEOUT_MS: Readonly<Record<OneShotBudget, number>> = {
  short: 6_000,
  status: 8_000,
  list: 10_000,
  standard: 12_000,
};

export const READINESS_TIMEOUT_MS: Readonly<Record<ReadinessBudget, number>> = {
  fast: 8_000,
  agent: 20_000,
};

const ProgramTypeId: unique symbol = Symbol("@vellum/ssh/Program");

export interface OneShotProgram {
  readonly [ProgramTypeId]: "oneShot";
}

export interface ScopedStreamProgram {
  readonly [ProgramTypeId]: "stream";
}

export interface ForwardProgram {
  readonly [ProgramTypeId]: "forward";
}

export interface DaemonHandoffProgram {
  readonly [ProgramTypeId]: "daemonHandoff";
}

type RemoteInvocation =
  | { readonly _tag: "Argv"; readonly command: RemoteCommand }
  | { readonly _tag: "TrustedScript"; readonly script: string };

interface OneShotPayload {
  readonly _tag: "OneShot";
  readonly endpoint: SshEndpoint;
  readonly invocation: RemoteInvocation;
  readonly timeoutMs: number;
  readonly stdin?: Uint8Array;
}

interface StreamPayload {
  readonly _tag: "Stream";
  readonly endpoint: SshEndpoint;
  readonly invocation: RemoteInvocation;
  readonly connection: "shared" | "dedicated";
  readonly readinessTimeoutMs: number;
}

interface ForwardPayload {
  readonly _tag: "Forward";
  readonly endpoint: SshEndpoint;
  readonly localSocket: UnixSocketPath;
  readonly remoteSocket: UnixSocketPath;
  readonly readinessTimeoutMs: number;
}

interface DaemonPayload {
  readonly _tag: "DaemonHandoff";
  readonly endpoint: SshEndpoint;
  readonly command: RemoteCommand;
  readonly readinessTimeoutMs: number;
}

export type ProgramPayload = OneShotPayload | StreamPayload | ForwardPayload | DaemonPayload;

const payloads = new WeakMap<object, ProgramPayload>();

const opaque = <A extends object>(tag: string, payload: ProgramPayload): A => {
  const value = Object.freeze({ [ProgramTypeId]: tag }) as A;
  payloads.set(value, payload);
  return value;
};

export const oneShot = (
  endpoint: SshEndpoint,
  command: RemoteCommand,
  options?: { readonly budget?: OneShotBudget; readonly stdin?: Uint8Array },
): OneShotProgram =>
  opaque<OneShotProgram>("oneShot", {
    _tag: "OneShot",
    endpoint,
    invocation: { _tag: "Argv", command },
    timeoutMs: ONE_SHOT_TIMEOUT_MS[options?.budget ?? "standard"],
    ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
  });

// Fixed shell expansion required by Unix-forward discovery. Callers cannot
// supply shell text; the only authorial surface is this named operation.
export const homeDirectoryLookup = (endpoint: SshEndpoint): OneShotProgram =>
  opaque<OneShotProgram>("oneShot", {
    _tag: "OneShot",
    endpoint,
    invocation: { _tag: "TrustedScript", script: `printf '%s\\n' "$HOME"` },
    timeoutMs: ONE_SHOT_TIMEOUT_MS.short,
  });

export const sharedStream = (
  endpoint: SshEndpoint,
  command: RemoteCommand,
  readiness: ReadinessBudget = "fast",
): ScopedStreamProgram =>
  opaque<ScopedStreamProgram>("stream", {
    _tag: "Stream",
    endpoint,
    invocation: { _tag: "Argv", command },
    connection: "shared",
    readinessTimeoutMs: READINESS_TIMEOUT_MS[readiness],
  });

export const dedicatedStream = (
  endpoint: SshEndpoint,
  command: RemoteCommand,
  readiness: ReadinessBudget = "agent",
): ScopedStreamProgram =>
  opaque<ScopedStreamProgram>("stream", {
    _tag: "Stream",
    endpoint,
    invocation: { _tag: "Argv", command },
    connection: "dedicated",
    readinessTimeoutMs: READINESS_TIMEOUT_MS[readiness],
  });

export const unixForward = (
  endpoint: SshEndpoint,
  localSocket: UnixSocketPath,
  remoteSocket: UnixSocketPath,
): ForwardProgram =>
  opaque<ForwardProgram>("forward", {
    _tag: "Forward",
    endpoint,
    localSocket,
    remoteSocket,
    readinessTimeoutMs: READINESS_TIMEOUT_MS.fast,
  });

export const daemonHandoff = (
  endpoint: SshEndpoint,
  command: RemoteCommand,
): DaemonHandoffProgram =>
  opaque<DaemonHandoffProgram>("daemonHandoff", {
    _tag: "DaemonHandoff",
    endpoint,
    command,
    readinessTimeoutMs: READINESS_TIMEOUT_MS.fast,
  });

export const inspectProgram = (
  program: OneShotProgram | ScopedStreamProgram | ForwardProgram | DaemonHandoffProgram,
): ProgramPayload => {
  const payload = payloads.get(program);
  if (!payload) throw new TypeError("SSH program was not created by an SSH operation factory");
  return payload;
};

export const quoteRemoteToken = (token: string): string =>
  `'${token.replaceAll("'", `'"'"'`)}'`;

const renderRemoteCommand = (command: RemoteCommand): string => {
  const parts = inspectRemoteCommand(command);
  return [parts.executable, ...parts.args].map(quoteRemoteToken).join(" ");
};

const BASE_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=6",
  "-o", "ConnectionAttempts=1",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-o", "RequestTTY=no",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "PermitLocalCommand=no",
] as const;

const sharedOptions = (controlDir: string): ReadonlyArray<string> => [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${controlDir}/cm-%C`,
  "-o", "ControlPersist=600",
];

const DEDICATED_OPTIONS = [
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
] as const;

const invocationText = (invocation: RemoteInvocation): string =>
  invocation._tag === "Argv" ? renderRemoteCommand(invocation.command) : invocation.script;

const normalArgs = (
  endpoint: SshEndpoint,
  invocation: RemoteInvocation,
  connection: "shared" | "dedicated",
  controlDir: string,
): ReadonlyArray<string> => [
  ...BASE_OPTIONS,
  "-o", "ClearAllForwardings=yes",
  ...(connection === "shared" ? sharedOptions(controlDir) : DEDICATED_OPTIONS),
  endpoint,
  invocationText(invocation),
];

export const compileProgram = (
  payload: ProgramPayload,
  controlDir: string,
): Command.Command => {
  switch (payload._tag) {
    case "OneShot":
      return Command.make("ssh", ...normalArgs(payload.endpoint, payload.invocation, "shared", controlDir));
    case "Stream":
      return Command.make(
        "ssh",
        ...normalArgs(payload.endpoint, payload.invocation, payload.connection, controlDir),
      );
    case "Forward":
      return Command.make(
        "ssh",
        ...BASE_OPTIONS,
        "-o", "ClearAllForwardings=yes",
        ...DEDICATED_OPTIONS,
        "-o", "ExitOnForwardFailure=yes",
        "-N",
        "-L", `${payload.localSocket}:${payload.remoteSocket}`,
        payload.endpoint,
      );
    case "DaemonHandoff": {
      const remote = renderRemoteCommand(payload.command);
      const script = `nohup ${remote} </dev/null >/dev/null 2>&1 & printf '%s\\n' "$!"`;
      return Command.make(
        "ssh",
        ...normalArgs(
          payload.endpoint,
          { _tag: "TrustedScript", script },
          "shared",
          controlDir,
        ),
      );
    }
  }
};

export const compileMasterWarm = (endpoint: SshEndpoint, controlDir: string): Command.Command =>
  Command.make(
    "ssh",
    ...normalArgs(
      endpoint,
      { _tag: "TrustedScript", script: "true" },
      "shared",
      controlDir,
    ),
  );

export const compileMasterExit = (endpoint: SshEndpoint, controlDir: string): Command.Command =>
  Command.make(
    "ssh",
    ...BASE_OPTIONS,
    "-o", `ControlPath=${controlDir}/cm-%C`,
    "-O", "exit",
    endpoint,
  );
