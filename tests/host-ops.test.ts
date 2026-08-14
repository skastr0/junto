import { readFileSync } from "node:fs";
import { Effect, Layer, Schema } from "effect";
import type { Context } from "effect";
import { describe, expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import {
  HostConfigure,
  HostOps,
  HostTarget,
} from "../src/main/vellum/hosts/host-ops";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import { SshTransport } from "../src/main/vellum/ssh/service";

const unusedSsh = {
  warm: () => Effect.fail(new Error("down")),
  run: () => Effect.fail(new Error("down")),
  forward: () => Effect.fail(new Error("down")),
} as unknown as Context.Service.Shape<typeof SshTransport>;

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

describe("host-ops layers", () => {
  it("loads a platform layer instead of switching OS in the verb", () => {
    const source = readFileSync(
      new URL("../src/main/vellum/hosts/host-ops.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("Layer.unwrap");
    expect(source).toContain("layerDarwin");
    expect(source).toContain("layerLinux");
    expect(source).toContain("HostTarget");
    expect(source).toContain("HostConfigure");
    expect(source).toContain("configure:");
    expect(source).toContain("activate:");
    expect(source).toContain("attach:");
    expect(source).not.toContain("uname.success");
    expect(source).not.toContain('stdout === "Darwin');
    expect(source).not.toContain("adapterFor");
  });

  it("same inspect program, Darwin layer, no target argument", async () => {
    const target = await parseTarget("remote-a");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.inspect();
      }).pipe(
        Effect.provide(HostOps.layerDarwin.pipe(Layer.provide(provideHost(target)))),
      ),
    );
    expect(receipt.platform).toBe("darwin");
    expect(receipt.network).toBe("down");
    expect(receipt.endpoint).toBe("remote-a");
    expect(receipt.process).toBe("unknown");
    expect(receipt.workAttach).toBe("unknown");
  });

  it("same inspect program, Linux layer, no target argument", async () => {
    const target = await parseTarget("studio");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.inspect();
      }).pipe(
        Effect.provide(HostOps.layerLinux.pipe(Layer.provide(provideHost(target)))),
      ),
    );
    expect(receipt.platform).toBe("linux");
    expect(receipt.network).toBe("down");
    expect(receipt.endpoint).toBe("studio");
    expect(receipt.process).toBe("unknown");
    expect(receipt.workAttach).toBe("unknown");
  });

  it("Linux copy refuses without switching OS in the verb", async () => {
    const target = await parseTarget("studio");
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return yield* ops.copy();
      }).pipe(
        Effect.provide(HostOps.layerLinux.pipe(Layer.provide(provideHost(target)))),
      ),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.tag).toBe("LINUX_REMOTE_DEPLOY_OFF");
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

  it("configure / activate / attach take no target and return receipts", async () => {
    const target = await parseTarget("remote-a");
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
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
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const ops = yield* HostOps;
        return {
          activate: yield* ops.activate(),
          attach: yield* ops.attach(),
        };
      }).pipe(
        Effect.provide(HostOps.layerLinux.pipe(Layer.provide(provideHost(target)))),
      ),
    );
    expect(receipts.activate.ok).toBe(false);
    expect(receipts.attach.workAttach).toBe("unknown");
  });

  it("Darwin attach is a term connect; Linux attach is work-control handshake", () => {
    const darwin = readFileSync(
      new URL("../src/main/vellum/hosts/host-ops-darwin.ts", import.meta.url),
      "utf8",
    );
    const linux = readFileSync(
      new URL("../src/main/vellum/hosts/host-ops-linux.ts", import.meta.url),
      "utf8",
    );
    expect(darwin).toContain("TermControlClient.connect");
    expect(darwin).toContain("activateDarwinRemoteRuntimeForTarget");
    expect(darwin).toContain("configureRemoteHost");
    expect(darwin).not.toContain("handshakeLinuxWorkControl");
    expect(linux).toContain("handshakeLinuxWorkControl");
    expect(linux).toContain("activateLinuxRemoteRuntimeForTarget");
    expect(linux).toContain("configureRemoteHost");
    expect(linux).not.toContain("TermControlClient");
    expect(linux).toContain("LINUX_REMOTE_DEPLOY_OFF");
  });
});
