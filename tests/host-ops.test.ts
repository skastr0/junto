import * as Command from "effect/unstable/process/ChildProcess";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import type { Context } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeWorkFrame,
  workOk,
} from "../src/shared/work-control";
import { TERM_CONTROL_PROTOCOL } from "../src/shared/term-control";
import {
  HostOpsActivate,
  HostOpsAttach,
  HostOpsConfigure,
  HostOpsInspect,
} from "../src/shared/host-ops";
import { InstallationId } from "../src/shared/installation-id";
import {
  HostConfigure,
  HostOps,
  HostTarget,
} from "../src/main/vellum-command/hosts/host-ops";
import {
  parseSshEndpoint,
  SshExitError,
} from "../src/main/vellum-command/ssh/domain";
import {
  createSshProgramCompiler,
  type OneShotProgram,
} from "../src/main/vellum-command/ssh/program";
import { SshTransport } from "../src/main/vellum-command/ssh/service";

const unusedSsh = {
  warm: () => Effect.fail(new Error("down")),
  run: () => Effect.fail(new Error("down")),
  forward: () => Effect.fail(new Error("down")),
} as unknown as Context.Service.Shape<typeof SshTransport>;

const compiler = createSshProgramCompiler({
  controlDir: "/tmp/vc-0-abcd1234",
  envExecutable: "/usr/bin/env",
  sshExecutable: "/usr/bin/ssh",
  environment: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
});

const remoteLine = (program: Parameters<typeof compiler.oneShot>[0]): string => {
  const compiled = compiler.oneShot(program);
  if (!Command.isStandardCommand(compiled.command)) {
    throw new TypeError("expected StandardCommand");
  }
  return compiled.command.args.at(-1) ?? "";
};

const absent = (endpoint: string, operation: string) =>
  Effect.fail(
    new SshExitError({
      endpoint,
      operation,
      code: 1,
    }),
  );

const scriptedSsh = (script: {
  readonly home: string;
  readonly token?: string;
  readonly forwardTo?: string;
  readonly observe?: string;
  readonly doors?: { readonly enroll: "up" | "down"; readonly peer: "up" | "down" };
}): Context.Service.Shape<typeof SshTransport> => {
  const endpoint = "scripted";
  const doors = script.doors ?? { enroll: "down", peer: "down" };
  return {
    warm: () => Effect.void,
    run: (program: OneShotProgram) => {
      const line = remoteLine(program);
      if (line.includes("printf") && line.includes("$HOME")) {
        return Effect.succeed({ stdout: `${script.home}\n`, stderr: "" });
      }
      if (line.includes("LINUX_USERLAND_OBSERVE") || line.includes("present=")) {
        return Effect.succeed({
          stdout: script.observe ?? "LINUX_USERLAND_OBSERVE_V1 present=0\n",
          stderr: "",
        });
      }
      if (line.includes("/bin/test") && line.includes("-S")) {
        if (line.includes("/station/control.sock")) {
          return doors.enroll === "up"
            ? Effect.succeed({ stdout: "", stderr: "" })
            : absent(endpoint, "test");
        }
        if (line.includes("/station/peer.sock")) {
          return doors.peer === "up"
            ? Effect.succeed({ stdout: "", stderr: "" })
            : absent(endpoint, "test");
        }
        return absent(endpoint, "test");
      }
      if (line.includes("/bin/test")) {
        return absent(endpoint, "test");
      }
      if (line.includes("/bin/cat") && script.token !== undefined) {
        return Effect.succeed({ stdout: `${script.token}\n`, stderr: "" });
      }
      if (line.includes("/bin/cat")) {
        return absent(endpoint, "cat");
      }
      return Effect.succeed({
        stdout: script.observe ?? "",
        stderr: "",
      });
    },
    forward: () =>
      script.forwardTo === undefined
        ? Effect.fail(new Error("no forward"))
        : Effect.succeed({
            localSocket: script.forwardTo,
            close: Effect.void,
            exitCode: Effect.succeed(0),
          }),
  } as unknown as Context.Service.Shape<typeof SshTransport>;
};

const scratchDirs: string[] = [];
let termServer: Server | undefined;
let workServer: Server | undefined;

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "vellum-host-ops-"));
  scratchDirs.push(dir);
  return dir;
};

const closeServer = async (server: Server): Promise<void> =>
  await new Promise((resolve) => {
    server.close(() => resolve());
  });

const listenTermAuth = (
  path: string,
  token: string,
): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let msg: { readonly token?: string };
        try {
          msg = JSON.parse(buf.slice(0, nl)) as { readonly token?: string };
        } catch {
          return;
        }
        socket.write(
          `${JSON.stringify(
            msg.token === token
              ? { v: TERM_CONTROL_PROTOCOL, ok: true, id: "auth" }
              : {
                  v: TERM_CONTROL_PROTOCOL,
                  ok: false,
                  error: "auth failed",
                },
          )}\n`,
        );
      });
    });
    server.on("error", reject);
    server.listen(path, () => resolve(server));
  });

const listenWorkPing = (path: string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        socket.write(encodeWorkFrame(workOk("ping", { pong: true })));
      });
    });
    server.on("error", reject);
    server.listen(path, () => resolve(server));
  });

afterEach(async () => {
  if (termServer !== undefined) {
    await closeServer(termServer);
    termServer = undefined;
  }
  if (workServer !== undefined) {
    await closeServer(workServer);
    workServer = undefined;
  }
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const provideHost = (sshTarget: Awaited<ReturnType<typeof parseTarget>>) =>
  Layer.mergeAll(
    Layer.succeed(SshTransport, unusedSsh),
    HostTarget.layer(sshTarget),
  );

const parseTarget = (endpoint: string) =>
  Effect.runPromise(parseSshEndpoint(endpoint));

const pairFacts = {
  commandCenterInstallationId: Schema.decodeUnknownSync(InstallationId)(
    "cc-installation",
  ),
  appVersion: "0.1.0",
};

const runOps = <A>(
  target: Awaited<ReturnType<typeof parseTarget>>,
  layer: Layer.Layer<HostOps, never, SshTransport | HostTarget>,
  use: (
    ops: Context.Service.Shape<typeof HostOps>,
  ) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ops = yield* HostOps;
      return yield* use(ops);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(provideHost(target))))),
  );

describe("host-ops layers", () => {
  it("loads a platform layer instead of switching OS in the verb", () => {
    const source = readFileSync(
      new URL("../src/main/vellum-command/hosts/host-ops.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("Layer.unwrap");
    expect(source).toContain("layerDarwin");
    expect(source).toContain("layerLinux");
    expect(source).toContain("HostTarget");
    expect(source).toContain("HostConfigure");
    expect(source).toContain("layerUnset");
    expect(source).toContain("configure:");
    expect(source).toContain("activate:");
    expect(source).toContain("attach:");
    expect(source).not.toContain("uname.success");
    expect(source).not.toContain('stdout === "Darwin');
    expect(source).not.toContain("adapterFor");
    expect(source).not.toContain("process.platform");
    expect(source).not.toContain("Effect.Service");
    expect(source).not.toContain("unwrapEffect");
    expect(source).not.toContain(
      "configure: ConfigureRemoteOptions = UNSET_HOST_CONFIGURE",
    );
  });

  it("receipt schemas keep leftovers and add process plus workAttach", () => {
    const inspect = Schema.decodeUnknownSync(HostOpsInspect)({
      endpoint: "remote-a",
      platform: "darwin",
      network: "up",
      package: "present",
      deployLock: "absent",
      incoming: "absent",
      termSocket: "present",
      process: "up",
      workAttach: "down",
      observedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(inspect.process).toBe("up");
    expect(inspect.workAttach).toBe("down");
    expect(inspect.deployLock).toBe("absent");
    expect(inspect.termSocket).toBe("present");

    const configure = Schema.decodeUnknownSync(HostOpsConfigure)({
      ok: true,
      detail: "paired",
      observedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(configure.ok).toBe(true);

    const activate = Schema.decodeUnknownSync(HostOpsActivate)({
      ok: false,
      detail: "down",
      stages: [],
      observedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(activate.stages).toEqual([]);

    const attach = Schema.decodeUnknownSync(HostOpsAttach)({
      ok: false,
      workAttach: "unknown",
      detail: "work attach unknown",
      observedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(attach.workAttach).toBe("unknown");
  });

  it("same inspect program, Darwin layer, no target argument", async () => {
    const target = await parseTarget("remote-a");
    const receipt = await runOps(target, HostOps.layerDarwin, (ops) => {
      expect(ops.inspect.length).toBe(0);
      return ops.inspect();
    });
    expect(receipt.platform).toBe("darwin");
    expect(receipt.network).toBe("down");
    expect(receipt.endpoint).toBe("remote-a");
    expect(receipt.package).toBe("unknown");
    expect(receipt.deployLock).toBe("unknown");
    expect(receipt.incoming).toBe("unknown");
    expect(receipt.termSocket).toBe("unknown");
    expect(receipt.process).toBe("unknown");
    expect(receipt.workAttach).toBe("unknown");
  });

  it("same inspect program, Linux layer, no target argument", async () => {
    const target = await parseTarget("studio");
    const receipt = await runOps(target, HostOps.layerLinux, (ops) =>
      ops.inspect(),
    );
    expect(receipt.platform).toBe("linux");
    expect(receipt.network).toBe("down");
    expect(receipt.endpoint).toBe("studio");
    expect(receipt.package).toBe("unknown");
    expect(receipt.deployLock).toBe("absent");
    expect(receipt.incoming).toBe("absent");
    expect(receipt.process).toBe("unknown");
    expect(receipt.workAttach).toBe("unknown");
  });

  it("Linux copy refuses without switching OS in the verb", async () => {
    const target = await parseTarget("studio");
    const receipt = await runOps(target, HostOps.layerLinux, (ops) =>
      ops.copy(),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.tag).toBe("LINUX_REMOTE_DEPLOY_OFF");
  });

  it("cleanup is a no-target program on both layers", async () => {
    const darwin = await runOps(
      await parseTarget("remote-a"),
      HostOps.layerDarwin,
      (ops) => ops.cleanup(),
    );
    expect(darwin.ok).toBe(false);
    expect(darwin.removed).toEqual([]);

    const linux = await runOps(
      await parseTarget("studio"),
      HostOps.layerLinux,
      (ops) => ops.cleanup(),
    );
    expect(linux.ok).toBe(true);
    expect(linux.removed).toEqual([]);
  });

  it("layerForTarget unwraps Darwin after the platform probe", async () => {
    const ssh = {
      warm: () => Effect.void,
      run: () => Effect.succeed({ stdout: "Darwin\n", stderr: "" }),
    } as unknown as Context.Service.Shape<typeof SshTransport>;
    const target = await parseTarget("remote-a");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.inspect();
      }).pipe(
        Effect.provide(
          HostOps.layerForTarget(target).pipe(
            Layer.provide(HostConfigure.layerUnset),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.platform).toBe("darwin");
    expect(receipt.network).toBe("up");
    expect(receipt.process).toBe("unknown");
    expect(receipt.workAttach).toBe("unknown");
  });

  it("layerForTarget unwraps Linux after the platform probe", async () => {
    const ssh = {
      warm: () => Effect.void,
      run: () => Effect.succeed({ stdout: "Linux\n", stderr: "" }),
    } as unknown as Context.Service.Shape<typeof SshTransport>;
    const target = await parseTarget("studio");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.inspect();
      }).pipe(
        Effect.provide(
          HostOps.layerForTarget(target).pipe(
            Layer.provide(HostConfigure.layerUnset),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.platform).toBe("linux");
    expect(receipt.network).toBe("up");
    expect(receipt.process).toBe("unknown");
    expect(receipt.workAttach).toBe("unknown");
  });

  it("configure / activate / attach take no target and return receipts", async () => {
    const target = await parseTarget("remote-a");
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        expect(ops.configure.length).toBe(0);
        expect(ops.activate.length).toBe(0);
        expect(ops.attach.length).toBe(0);
        return {
          configure: yield* ops.configure(),
          activate: yield* ops.activate(),
          attach: yield* ops.attach(),
        };
      }).pipe(
        Effect.provide(
          HostOps.layerDarwinOps.pipe(
            Layer.provide(provideHost(target)),
            Layer.provide(HostConfigure.layer(pairFacts)),
          ),
        ),
      ),
    );
    expect(receipts.configure.ok).toBe(false);
    expect(receipts.configure.detail.length).toBeGreaterThan(0);
    expect(receipts.activate.ok).toBe(false);
    expect(receipts.activate.stages).toEqual([]);
    expect(receipts.attach.ok).toBe(false);
    expect(receipts.attach.workAttach).toBe("unknown");
  });

  it("Linux activate and attach are the same programs as Darwin", async () => {
    const target = await parseTarget("studio");
    const receipts = await runOps(target, HostOps.layerLinux, (ops) =>
      Effect.gen(function* () {
        return {
          activate: yield* ops.activate(),
          attach: yield* ops.attach(),
        };
      }),
    );
    expect(receipts.activate.ok).toBe(false);
    expect(receipts.attach.workAttach).toBe("unknown");
  });

  it("Darwin process is up when an enroll door socket exists", async () => {
    const ssh = scriptedSsh({
      home: "/Users/alice",
      doors: { enroll: "up", peer: "down" },
    });
    const target = await parseTarget("remote-a");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.inspect();
      }).pipe(
        Effect.provide(
          HostOps.layerDarwin.pipe(
            Layer.provide(HostTarget.layer(target)),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.network).toBe("up");
    expect(receipt.process).toBe("up");
    expect(receipt.workAttach).toBe("down");
  });

  it("Darwin attach is up after TermControlClient.connect authenticates", async () => {
    const dir = await scratchDir();
    const sock = join(dir, "term.sock");
    const token = "term-token";
    termServer = await listenTermAuth(sock, token);
    const ssh = scriptedSsh({
      home: "/Users/alice",
      token,
      forwardTo: sock,
    });
    const target = await parseTarget("remote-a");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.attach();
      }).pipe(
        Effect.provide(
          HostOps.layerDarwin.pipe(
            Layer.provide(HostTarget.layer(target)),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.ok).toBe(true);
    expect(receipt.workAttach).toBe("up");
  });

  it("Darwin attach is down on ECONNREFUSED, not Ready", async () => {
    const dir = await scratchDir();
    const stale = join(dir, "stale.sock");
    const parked = await listenTermAuth(stale, "unused");
    await closeServer(parked);
    const ssh = scriptedSsh({
      home: "/Users/alice",
      token: "term-token",
      forwardTo: stale,
    });
    const target = await parseTarget("remote-a");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.attach();
      }).pipe(
        Effect.provide(
          HostOps.layerDarwin.pipe(
            Layer.provide(HostTarget.layer(target)),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.workAttach).toBe("down");
  });

  it("Linux process is up when a peer door socket exists", async () => {
    const ssh = scriptedSsh({
      home: "/home/alice",
      observe: "LINUX_USERLAND_OBSERVE_V1 present=1\n",
      doors: { enroll: "down", peer: "up" },
    });
    const target = await parseTarget("studio");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.inspect();
      }).pipe(
        Effect.provide(
          HostOps.layerLinux.pipe(
            Layer.provide(HostTarget.layer(target)),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.network).toBe("up");
    expect(receipt.process).toBe("up");
  });

  it("Linux attach is up after a work-control handshake", async () => {
    const dir = await scratchDir();
    const sock = join(dir, "work.sock");
    workServer = await listenWorkPing(sock);
    const ssh = scriptedSsh({
      home: "/home/alice",
      token: "work-token",
      forwardTo: sock,
    });
    const target = await parseTarget("studio");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.attach();
      }).pipe(
        Effect.provide(
          HostOps.layerLinux.pipe(
            Layer.provide(HostTarget.layer(target)),
            Layer.provide(Layer.succeed(SshTransport, ssh)),
          ),
        ),
      ),
    );
    expect(receipt.ok).toBe(true);
    expect(receipt.workAttach).toBe("up");
  });

  it("Darwin attach is a term connect; Linux attach is work-control handshake", () => {
    const darwin = readFileSync(
      new URL("../src/main/vellum-command/hosts/host-ops-darwin.ts", import.meta.url),
      "utf8",
    );
    const linux = readFileSync(
      new URL("../src/main/vellum-command/hosts/host-ops-linux.ts", import.meta.url),
      "utf8",
    );
    expect(darwin).toContain("TermControlClient.connect");
    expect(darwin).toContain("compileExpectedPackageState");
    expect(darwin).toContain('stationDoorSocketPath(stationHome, "enroll")');
    expect(darwin).toContain('stationDoorSocketPath(stationHome, "peer")');
    expect(darwin).not.toContain("handshakeLinuxWorkControl");
    expect(linux).toContain("handshakeLinuxWorkControl");
    expect(linux).toContain('stationDoorSocketPath(stationHome, "enroll")');
    expect(linux).toContain('stationDoorSocketPath(stationHome, "peer")');
    expect(linux).not.toContain("TermControlClient");
    expect(linux).toContain("LINUX_REMOTE_DEPLOY_OFF");
    const ops = readFileSync(
      new URL("../src/main/vellum-command/hosts/host-ops.ts", import.meta.url),
      "utf8",
    );
    expect(ops).toContain("configureRemoteHost");
    expect(ops).toContain("activateDarwinRemoteRuntimeForTarget");
    expect(ops).toContain("activateLinuxRemoteRuntimeForTarget");
  });

  it("keeps the host-ops script a read-only surface", () => {
    const script = readFileSync(
      new URL("../scripts/host-ops.ts", import.meta.url),
      "utf8",
    );
    expect(script).toContain('const verbs = ["inspect", "attach"] as const');
    for (const mutation of [
      "ops.copy(",
      "ops.cleanup(",
      "ops.configure(",
      "ops.activate(",
    ]) {
      expect(script).not.toContain(mutation);
    }
  });
});
