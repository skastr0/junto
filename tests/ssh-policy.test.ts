import * as Command from "@effect/platform/Command";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer, Scope, Sink, Stream } from "effect";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHermesProfileName } from "../src/main/vellum/hermes/domain";
import {
  HermesTransport,
  HermesTransportLive,
  resolveHermesRemoteHost,
} from "../src/main/vellum/hermes/transport";
import { setHostsSnapshot } from "../src/main/vellum/hosts/snapshot";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import {
  parseRemoteUnixSocketPath,
  parseSshEndpoint,
  SshTransport,
} from "../src/main/vellum/ssh";
import { makeRemoteCommand } from "../src/main/vellum/ssh/domain";
import {
  createSshProgramCompiler,
  daemonHandoff,
  deploymentStream,
  dedicatedStream,
  oneShot,
  unixForward,
} from "../src/main/vellum/ssh/program";
import {
  ProcessSpawner,
  type ProcessHandle,
} from "../src/main/vellum/ssh/process-spawner";
import { SshTransportConfig, SshTransportLayer } from "../src/main/vellum/ssh/service";

const encoder = new TextEncoder();
const temporaryDirs: string[] = [];

afterEach(async () => {
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
  await Promise.all(temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const standard = (command: Command.Command): Command.StandardCommand => Command.flatten(command)[0];

const sshArgs = (command: Command.StandardCommand): ReadonlyArray<string> => {
  const index = command.args.indexOf("/usr/bin/ssh");
  expect(index).toBeGreaterThanOrEqual(0);
  return command.args.slice(index + 1);
};

const handle = (options?: {
  readonly running?: boolean;
  readonly stdout?: Uint8Array;
}): ProcessHandle => ({
  pid: 42,
  exitCode: options?.running === true ? Effect.never : Effect.succeed(0),
  isRunning: Effect.succeed(options?.running === true),
  stdin: Sink.drain,
  stdout: Stream.fromIterable(options?.stdout === undefined ? [] : [options.stdout]),
  stderr: Stream.empty,
});

interface MasterReleaseSnapshot {
  readonly controlSocketExists: boolean;
  readonly localSocketExists: boolean;
}

const recordingLayer = async (
  calls: Command.StandardCommand[],
  masterReleases?: MasterReleaseSnapshot[],
) => {
  const root = await mkdtemp("/tmp/vellum-ssh-policy-");
  temporaryDirs.push(root);
  const controlDir = join(root, "control");
  const forwardedLocalSockets = new Map<string, string>();
  const spawner = ProcessSpawner.of({
    start: (command) => {
      let ownedMasterControlSocket: string | undefined;
      return Effect.acquireRelease(
        Effect.promise(async () => {
          const flattened = standard(command);
          calls.push(flattened);
          const args = sshArgs(flattened);
          const isMaster = args.includes("-M");
          if (isMaster) {
            const controlSocket = args[args.indexOf("-S") + 1] ?? "";
            await writeFile(controlSocket, "owned-master");
            ownedMasterControlSocket = controlSocket;
          }
          const controlOperation = args[args.indexOf("-O") + 1];
          if (controlOperation === "forward") {
            const spec = args[args.indexOf("-L") + 1] ?? "";
            const localSocket = spec.slice(0, spec.indexOf(":"));
            const controlSocket = args[args.indexOf("-S") + 1] ?? "";
            forwardedLocalSockets.set(controlSocket, localSocket);
            await mkdir(dirname(localSocket), { recursive: true });
            await writeFile(localSocket, "owned-forward");
          }
          const remoteText = args.at(-1) ?? "";
          return handle({
            running: isMaster || args.includes("ControlMaster=no"),
            stdout: remoteText.includes("nohup") ? encoder.encode("4242\n") : undefined,
          });
        }),
        () =>
          Effect.sync(() => {
            if (ownedMasterControlSocket !== undefined) {
              const localSocket = forwardedLocalSockets.get(
                ownedMasterControlSocket,
              );
              masterReleases?.push({
                controlSocketExists: existsSync(ownedMasterControlSocket),
                localSocketExists:
                  localSocket !== undefined && existsSync(localSocket),
              });
            }
          }),
      );
    },
  });
  return SshTransportLayer.pipe(
    Layer.provide(Layer.succeed(ProcessSpawner, spawner)),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(
      Layer.succeed(SshTransportConfig, {
        controlDir,
        envExecutable: "/usr/bin/env",
        sshExecutable: "/usr/bin/ssh",
        environment: {
          HOME: root,
          PATH: "/usr/bin:/bin",
          SSH_AUTH_SOCK: join(root, "agent.sock"),
        },
        maxConcurrentDials: 6,
        maxConcurrentDialsPerEndpoint: 2,
      }),
    ),
  );
};

describe("SSH policy surface", () => {
  it("uses an absolute executable, scrubbed environment, hardened baseline, and versioned mux", async () => {
    const calls: Command.StandardCommand[] = [];
    const layer = await recordingLayer(calls);
    await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand(
          "herdr",
          ["--session", "team one", "it's", "$(touch /tmp/pwn)"],
        );
        yield* (yield* SshTransport).run(oneShot(endpoint, remote));
      }).pipe(Effect.provide(layer)),
    );

    const compiled = calls.find((call) => sshArgs(call).at(-1)?.includes("team one"));
    expect(compiled?.command).toBe("/usr/bin/env");
    expect(compiled?.args[0]).toBe("-i");
    expect(compiled?.args).toContain("HOME=" + temporaryDirs[0]);
    expect(compiled?.args).toContain("PATH=/usr/bin:/bin");
    expect(compiled?.args).not.toContain(expect.stringContaining("APP_SECRET="));
    const args = sshArgs(compiled!);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=6");
    expect(args).toContain("ConnectionAttempts=1");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args).toContain("RequestTTY=no");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("ForwardX11=no");
    expect(args).toContain("PermitLocalCommand=no");
    expect(args).toContain("ForkAfterAuthentication=no");
    expect(args).toContain("StdinNull=no");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).toContain("ControlMaster=auto");
    expect(args.some((arg) => arg.includes("/cm-v1-%C"))).toBe(true);
    expect(args.filter((arg) => arg.startsWith("ControlPersist="))).toEqual([
      "ControlPersist=no",
    ]);
    const remoteText = args.at(-1) ?? "";
    expect(remoteText).toContain("'team one'");
    expect(remoteText).toContain(`'it'"'"'s'`);
    expect(remoteText).toContain("'$(touch /tmp/pwn)'");
  });

  it("makes dedicated streams caller-scoped and explicitly non-multiplexed", async () => {
    const calls: Command.StandardCommand[] = [];
    const layer = await recordingLayer(calls);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* makeRemoteCommand("hermes", ["acp"]);
          yield* (yield* SshTransport).connect(
            dedicatedStream(endpoint, remote),
            (_lease, confirm) => Effect.succeed(confirm("ready")),
          );
        }),
      ).pipe(Effect.provide(layer)),
    );

    const args = sshArgs(calls.find((call) => sshArgs(call).at(-1)?.includes("hermes"))!);
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
    expect(args).not.toContain("ControlMaster=auto");
  });

  it("keeps deployment streams dedicated for one bounded privileged transcript", async () => {
    const endpoint = await Effect.runPromise(parseSshEndpoint("linux-station"));
    const remote = await Effect.runPromise(
      makeRemoteCommand("/usr/libexec/vellum-release-bridge", []),
    );
    const compiler = createSshProgramCompiler({
      controlDir: "/tmp/vellum-ssh-policy-test",
      envExecutable: "/usr/bin/env",
      sshExecutable: "/usr/bin/ssh",
      environment: {
        HOME: "/tmp/vellum-ssh-policy-home",
        PATH: "/usr/bin:/bin",
      },
    });

    const compiled = compiler.stream(deploymentStream(endpoint, remote));
    const args = sshArgs(standard(compiled.command));

    expect(compiled.connection).toBe("dedicated");
    expect(compiled.readinessTimeoutMs).toBe(20 * 60_000);
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
    expect(args).not.toContain("ControlMaster=auto");
  });

  it("renders Hermes operations through shared one-shots and isolated ACP streams", async () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "studio",
        label: "studio",
        kind: "remote",
        endpoint: "studio",
        capabilities: ["hermes"],
      },
    ]);
    const calls: Command.StandardCommand[] = [];
    const sshLayer = await recordingLayer(calls);
    const layer = Layer.provideMerge(HermesTransportLive, sshLayer);
    const profile = parseHermesProfileName("profile-13")!;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hermes = yield* HermesTransport;
          yield* hermes.profiles("studio");
          yield* hermes.avatar("studio", profile);
          yield* hermes.connectAcp("studio", profile, (_lease, confirm) =>
            Effect.succeed(confirm("ready")),
          );
        }),
      ).pipe(Effect.provide(layer)),
    );

    const remoteCalls = calls.map(sshArgs).filter((args) => !args.includes("-O"));
    const profiles = remoteCalls.find((args) => args.at(-1)?.includes("'profile' 'list'"));
    const avatar = remoteCalls.find((args) =>
      args.at(-1)?.includes("vellum-plan:hermes-avatar"),
    );
    const acp = remoteCalls.find((args) => args.at(-1)?.includes("'acp'"));

    expect(profiles).toContain("ControlMaster=auto");
    expect(avatar?.at(-1)).toContain("'profile-13'");
    expect(acp).toContain("ControlMaster=no");
    expect(acp).toContain("ControlPath=none");
  });

  it("admits only the canonical hermesId when it differs from the product host id", () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "studio",
        hermesId: "fleet-a",
        label: "studio",
        kind: "remote",
        endpoint: "studio",
        capabilities: ["hermes"],
      },
    ]);

    expect(resolveHermesRemoteHost("fleet-a")?.id).toBe("studio");
    expect(resolveHermesRemoteHost("studio")).toBeUndefined();
  });

  it("creates Unix forwarding through a dedicated owned mux generation", async () => {
    const calls: Command.StandardCommand[] = [];
    const masterReleases: MasterReleaseSnapshot[] = [];
    const layer = await recordingLayer(calls, masterReleases);
    let ownedSocket = "";
    let ownedControlSocket = "";
    let callsBeforeClose = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* parseSshEndpoint("remote-a");
          const remote = yield* parseRemoteUnixSocketPath("/Users/ops/.herdr/herdr.sock");
          const lease = yield* (yield* SshTransport).forward(unixForward(endpoint, remote));
          ownedSocket = String(lease.localSocket);
          expect(String(lease.localSocket)).toContain("/control/f-");
          const master = calls.find((call) => sshArgs(call).includes("-M"));
          const masterArgs = sshArgs(master!);
          ownedControlSocket = masterArgs[masterArgs.indexOf("-S") + 1] ?? "";
          callsBeforeClose = calls.length;
          yield* Effect.all([lease.close, lease.close], {
            concurrency: "unbounded",
          });
        }),
      ).pipe(Effect.provide(layer)),
    );

    const master = calls.find((call) => sshArgs(call).includes("-M"));
    const request = calls.find((call) => {
      const args = sshArgs(call);
      return args[args.indexOf("-O") + 1] === "forward";
    });
    expect(master).toBeDefined();
    expect(request).toBeDefined();
    const masterArgs = sshArgs(master!);
    expect(masterArgs).toContain("ClearAllForwardings=yes");
    expect(masterArgs).toContain("StreamLocalBindUnlink=yes");
    expect(masterArgs).toContain("ForkAfterAuthentication=no");
    expect(masterArgs).toContain("StdinNull=no");
    expect(masterArgs).not.toContain("-L");
    const requestArgs = sshArgs(request!);
    expect(requestArgs).toContain("-F");
    expect(requestArgs[requestArgs.indexOf("-F") + 1]).toBe("none");
    expect(requestArgs).toContain("-L");
    expect(requestArgs).not.toContain("ClearAllForwardings=yes");
    expect(requestArgs).toContain("ForkAfterAuthentication=no");
    expect(requestArgs).toContain("StdinNull=no");
    expect(requestArgs[requestArgs.indexOf("-L") + 1]).toMatch(
      /\/control\/f-[a-f0-9]{32}:\/Users\/ops\/\.herdr\/herdr\.sock/u,
    );
    expect(calls).toHaveLength(callsBeforeClose);
    expect(
      calls.flatMap((call) => {
        const args = sshArgs(call);
        const operation = args[args.indexOf("-O") + 1];
        return args.includes("-O") && operation !== undefined ? [operation] : [];
      }),
    ).toEqual(["check", "forward"]);
    expect(masterReleases).toEqual([
      { controlSocketExists: true, localSocketExists: true },
    ]);
    expect(existsSync(ownedSocket)).toBe(false);
    expect(existsSync(ownedControlSocket)).toBe(false);
  });

  it("builds the daemon handoff script only from quoted command tokens", async () => {
    const calls: Command.StandardCommand[] = [];
    const layer = await recordingLayer(calls);
    await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* parseSshEndpoint("remote-a");
        const remote = yield* makeRemoteCommand("herdr", ["--session", "red; echo bad", "server"]);
        yield* (yield* SshTransport).handoff(
          daemonHandoff(endpoint, remote),
          (confirm) => Effect.succeed(confirm("healthy")),
        );
      }).pipe(Effect.provide(layer)),
    );

    const script = calls.map(sshArgs).map((args) => args.at(-1) ?? "").find((arg) => arg.includes("nohup")) ?? "";
    expect(script).toContain("nohup 'herdr' '--session' 'red; echo bad' 'server'");
    expect(script).toContain(`printf '%s\\n' "$!"`);
  });
});
