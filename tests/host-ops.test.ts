import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { describe, expect, it } from "vitest";
import { HostOps, HostTarget } from "../src/main/vellum/hosts/host-ops";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import { SshTransport } from "../src/main/vellum/ssh/service";

const unusedSsh = {
  warm: () => Effect.fail(new Error("down")),
  run: () => Effect.fail(new Error("down")),
} as unknown as Context.Service.Shape<typeof SshTransport>;

const provideHost = (sshTarget: Awaited<ReturnType<typeof parseTarget>>) =>
  Layer.mergeAll(
    Layer.succeed(SshTransport, unusedSsh),
    HostTarget.layer(sshTarget),
  );

const parseTarget = (endpoint: string) =>
  Effect.runPromise(parseSshEndpoint(endpoint));

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
    expect(source).not.toContain("uname.success");
    expect(source).not.toContain('stdout === "Darwin');
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
  });
});