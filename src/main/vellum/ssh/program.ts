// S7 V4: @effect/platform/Command → effect/unstable/process/ChildProcess (not @effect/cli)
// Inventory: src/cli/effect-v4-import-map.ts — no rewrite while product is on effect@3.21
import * as Command from "@effect/platform/Command";
import { join } from "node:path";
import type {
  RemoteCommand,
  RemoteStdin,
  RemoteUnixSocketPath,
  SshEndpoint,
  SshTarget,
} from "./domain";
import {
  inspectRemoteCommand,
  inspectRemoteStdin,
  inspectSshTarget,
} from "./domain";

export type OneShotBudget =
  | "short"
  | "status"
  | "list"
  | "standard"
  | "bulk";
export type ReadinessBudget = "fast" | "agent";

const ONE_SHOT_TIMEOUT_MS: Readonly<Record<OneShotBudget, number>> = {
  short: 6_000,
  status: 8_000,
  list: 10_000,
  standard: 12_000,
  bulk: 20_000,
};

const READINESS_TIMEOUT_MS: Readonly<Record<ReadinessBudget, number>> = {
  fast: 8_000,
  agent: 20_000,
};

const DEPLOYMENT_STREAM_TIMEOUT_MS = 20 * 60_000;

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
  | { readonly _tag: "HomeDirectoryLookup" }
  | { readonly _tag: "MasterWarm" }
  | { readonly _tag: "DaemonHandoff"; readonly command: RemoteCommand };

interface OneShotPayload {
  readonly _tag: "OneShot";
  readonly target: SshTarget;
  readonly invocation: RemoteInvocation;
  readonly timeoutMs: number;
  readonly input?: RemoteStdin;
}

interface StreamPayload {
  readonly _tag: "Stream";
  readonly target: SshTarget;
  readonly command: RemoteCommand;
  readonly connection: "shared" | "dedicated";
  readonly readinessTimeoutMs: number;
}

interface ForwardPayload {
  readonly _tag: "Forward";
  readonly target: SshTarget;
  readonly remoteSocket: RemoteUnixSocketPath;
  readonly readinessTimeoutMs: number;
}

interface DaemonPayload {
  readonly _tag: "DaemonHandoff";
  readonly target: SshTarget;
  readonly command: RemoteCommand;
  readonly readinessTimeoutMs: number;
}

type ProgramPayload = OneShotPayload | StreamPayload | ForwardPayload | DaemonPayload;
type SshProgram = OneShotProgram | ScopedStreamProgram | ForwardProgram | DaemonHandoffProgram;

const payloads = new WeakMap<object, ProgramPayload>();

const opaque = <A extends object>(tag: string, payload: ProgramPayload): A => {
  const value = Object.freeze({ [ProgramTypeId]: tag }) as A;
  payloads.set(value, payload);
  return value;
};

export const oneShot = (
  target: SshTarget,
  command: RemoteCommand,
  options?: { readonly budget?: OneShotBudget },
): OneShotProgram =>
  opaque<OneShotProgram>("oneShot", {
    _tag: "OneShot",
    target,
    invocation: { _tag: "Argv", command },
    timeoutMs: ONE_SHOT_TIMEOUT_MS[options?.budget ?? "standard"],
  });

export const oneShotWithStdin = (
  target: SshTarget,
  command: RemoteCommand,
  input: RemoteStdin,
  options?: { readonly budget?: OneShotBudget },
): OneShotProgram =>
  opaque<OneShotProgram>("oneShot", {
    _tag: "OneShot",
    target,
    invocation: { _tag: "Argv", command },
    timeoutMs: ONE_SHOT_TIMEOUT_MS[options?.budget ?? "standard"],
    input,
  });

// This is the only public operation that expands a remote shell variable.
// The shell text remains closed inside the policy compiler.
export const homeDirectoryLookup = (target: SshTarget): OneShotProgram =>
  opaque<OneShotProgram>("oneShot", {
    _tag: "OneShot",
    target,
    invocation: { _tag: "HomeDirectoryLookup" },
    timeoutMs: ONE_SHOT_TIMEOUT_MS.short,
  });

export const sharedStream = (
  target: SshTarget,
  command: RemoteCommand,
  readiness: ReadinessBudget = "fast",
): ScopedStreamProgram =>
  opaque<ScopedStreamProgram>("stream", {
    _tag: "Stream",
    target,
    command,
    connection: "shared",
    readinessTimeoutMs: READINESS_TIMEOUT_MS[readiness],
  });

export const dedicatedStream = (
  target: SshTarget,
  command: RemoteCommand,
  readiness: ReadinessBudget = "agent",
): ScopedStreamProgram =>
  opaque<ScopedStreamProgram>("stream", {
    _tag: "Stream",
    target,
    command,
    connection: "dedicated",
    readinessTimeoutMs: READINESS_TIMEOUT_MS[readiness],
  });

/**
 * A deployment is one caller-scoped SSH capability, from candidate upload
 * through the privileged commit receipt. Its deliberately closed timeout is
 * long enough for package installation while retaining the non-multiplexed
 * connection boundary of a dedicated stream.
 */
export const deploymentStream = (
  target: SshTarget,
  command: RemoteCommand,
): ScopedStreamProgram =>
  opaque<ScopedStreamProgram>("stream", {
    _tag: "Stream",
    target,
    command,
    connection: "dedicated",
    readinessTimeoutMs: DEPLOYMENT_STREAM_TIMEOUT_MS,
  });

export const unixForward = (
  target: SshTarget,
  remoteSocket: RemoteUnixSocketPath,
): ForwardProgram =>
  opaque<ForwardProgram>("forward", {
    _tag: "Forward",
    target,
    remoteSocket,
    readinessTimeoutMs: READINESS_TIMEOUT_MS.fast,
  });

export const daemonHandoff = (
  target: SshTarget,
  command: RemoteCommand,
): DaemonHandoffProgram =>
  opaque<DaemonHandoffProgram>("daemonHandoff", {
    _tag: "DaemonHandoff",
    target,
    command,
    readinessTimeoutMs: READINESS_TIMEOUT_MS.fast,
  });

export interface SshExecutionPolicy {
  readonly controlDir: string;
  readonly envExecutable: string;
  readonly sshExecutable: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CompiledOneShot {
  readonly endpoint: SshEndpoint;
  readonly timeoutMs: number;
  readonly command: Command.Command;
  readonly input?: Uint8Array;
}

export interface CompiledStream {
  readonly endpoint: SshEndpoint;
  readonly readinessTimeoutMs: number;
  readonly connection: "shared" | "dedicated";
  readonly command: Command.Command;
}

export interface CompiledDaemonHandoff {
  readonly endpoint: SshEndpoint;
  readonly readinessTimeoutMs: number;
  readonly command: Command.Command;
}

export interface CompiledForward {
  readonly endpoint: SshEndpoint;
  readonly readinessTimeoutMs: number;
  readonly localSocket: string;
  readonly controlSocket: string;
  readonly master: Command.Command;
  readonly check: Command.Command;
  readonly request: Command.Command;
}

const quoteRemoteToken = (token: string): string =>
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
  "-o", "ForkAfterAuthentication=no",
  "-o", "StdinNull=no",
] as const;

const CONTROL_SOCKET_VERSION = "cm-v1-%C";
const OWNED_SOCKET_PATTERN = /^\/[A-Za-z0-9._+@/-]+$/u;
const NONCE_PATTERN = /^[a-f0-9]{32}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const decode = <P extends ProgramPayload["_tag"]>(
  program: SshProgram,
  tag: P,
): Extract<ProgramPayload, { readonly _tag: P }> => {
  const payload = payloads.get(program);
  if (!payload || payload._tag !== tag) {
    throw new TypeError(`SSH program is not a policy-created ${tag} operation`);
  }
  return payload as Extract<ProgramPayload, { readonly _tag: P }>;
};

const invocationText = (invocation: RemoteInvocation): string => {
  switch (invocation._tag) {
    case "Argv":
      return renderRemoteCommand(invocation.command);
    case "HomeDirectoryLookup":
      return `printf '%s\\n' "$HOME"`;
    case "MasterWarm":
      return "true";
    case "DaemonHandoff": {
      const remote = renderRemoteCommand(invocation.command);
      return `nohup ${remote} </dev/null >/dev/null 2>&1 & printf '%s\\n' "$!"`;
    }
  }
};

const assertOwnedSocket = (path: string): string => {
  if (!OWNED_SOCKET_PATTERN.test(path) || Buffer.byteLength(path, "utf8") > 103) {
    throw new TypeError("service-owned SSH socket path is outside the forwarding-safe boundary");
  }
  return path;
};

/**
 * The only policy compiler constructor. Its methods accept opaque operation
 * handles, so neither raw remote scripts nor caller-selected local sockets can
 * enter an SSH command.
 *
 * @internal consumed only by SshTransportLayer
 */
export const createSshProgramCompiler = (policy: SshExecutionPolicy) => {
  const environment = Object.entries(policy.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!ENV_NAME_PATTERN.test(name) || value.includes("\u0000")) {
        throw new TypeError("SSH environment contains an invalid assignment");
      }
      return `${name}=${value}`;
    });

  const ssh = (args: ReadonlyArray<string>): Command.Command =>
    Command.make(
      policy.envExecutable,
      "-i",
      ...environment,
      policy.sshExecutable,
      ...args,
    );

  const sharedOptions = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(policy.controlDir, CONTROL_SOCKET_VERSION)}`,
    "-o", "ControlPersist=no",
  ] as const;

  const dedicatedOptions = [
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
  ] as const;

  const targetArgs = (
    target: SshTarget,
  ): {
    readonly endpoint: SshEndpoint;
    readonly options: ReadonlyArray<string>;
  } => {
    const route = inspectSshTarget(target);
    return {
      endpoint: route.endpoint,
      options: [
        ...(route.identityFile === undefined
          ? []
          : [
              "-o",
              `IdentityFile=${route.identityFile}`,
              "-o",
              "IdentitiesOnly=yes",
            ]),
        ...(route.hostKeyPolicy === "accept-new"
          ? ["-o", "StrictHostKeyChecking=accept-new"]
          : []),
      ],
    };
  };

  const normal = (
    target: SshTarget,
    invocation: RemoteInvocation,
    connection: "shared" | "dedicated",
  ): Command.Command => {
    const route = targetArgs(target);
    return ssh([
      ...BASE_OPTIONS,
      ...route.options,
      "-o", "ClearAllForwardings=yes",
      ...(connection === "shared" ? sharedOptions : dedicatedOptions),
      route.endpoint,
      invocationText(invocation),
    ]);
  };

  const control = (controlSocket: string, ...args: ReadonlyArray<string>): Command.Command =>
    ssh([
      "-F", "none",
      "-o", "BatchMode=yes",
      "-o", "ForkAfterAuthentication=no",
      "-o", "StdinNull=no",
      "-S", controlSocket,
      ...args,
      "placeholder",
    ]);

  return Object.freeze({
    oneShot(program: OneShotProgram): CompiledOneShot {
      const payload = decode(program, "OneShot");
      const route = inspectSshTarget(payload.target);
      return {
        endpoint: route.endpoint,
        timeoutMs: payload.timeoutMs,
        command: normal(payload.target, payload.invocation, "shared"),
        ...(payload.input === undefined ? {} : { input: inspectRemoteStdin(payload.input) }),
      };
    },

    stream(program: ScopedStreamProgram): CompiledStream {
      const payload = decode(program, "Stream");
      const route = inspectSshTarget(payload.target);
      return {
        endpoint: route.endpoint,
        readinessTimeoutMs: payload.readinessTimeoutMs,
        connection: payload.connection,
        command: normal(
          payload.target,
          { _tag: "Argv", command: payload.command },
          payload.connection,
        ),
      };
    },

    daemonHandoff(program: DaemonHandoffProgram): CompiledDaemonHandoff {
      const payload = decode(program, "DaemonHandoff");
      const route = inspectSshTarget(payload.target);
      return {
        endpoint: route.endpoint,
        readinessTimeoutMs: payload.readinessTimeoutMs,
        command: normal(
          payload.target,
          { _tag: "DaemonHandoff", command: payload.command },
          "shared",
        ),
      };
    },

    forward(program: ForwardProgram, nonce: string): CompiledForward {
      const payload = decode(program, "Forward");
      const route = targetArgs(payload.target);
      if (!NONCE_PATTERN.test(nonce)) throw new TypeError("SSH forward nonce is invalid");
      const localSocket = assertOwnedSocket(join(policy.controlDir, `f-${nonce}`));
      const controlSocket = assertOwnedSocket(join(policy.controlDir, `m-${nonce}`));
      const forwardSpec = `${localSocket}:${payload.remoteSocket}`;
      return {
        endpoint: route.endpoint,
        readinessTimeoutMs: payload.readinessTimeoutMs,
        localSocket,
        controlSocket,
        master: ssh([
          ...BASE_OPTIONS,
          ...route.options,
          "-M",
          "-S", controlSocket,
          "-o", "ControlPersist=no",
          "-o", "ClearAllForwardings=yes",
          "-o", "StreamLocalBindUnlink=yes",
          "-o", "StreamLocalBindMask=0177",
          "-N",
          route.endpoint,
        ]),
        check: control(controlSocket, "-O", "check"),
        request: control(controlSocket, "-O", "forward", "-L", forwardSpec),
      };
    },

    masterWarm(target: SshTarget): Command.Command {
      return normal(target, { _tag: "MasterWarm" }, "shared");
    },

    masterExit(endpoint: SshEndpoint): Command.Command {
      return ssh([
        ...BASE_OPTIONS,
        "-o", `ControlPath=${join(policy.controlDir, CONTROL_SOCKET_VERSION)}`,
        "-O", "exit",
        endpoint,
      ]);
    },
  });
};
