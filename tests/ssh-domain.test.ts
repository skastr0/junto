import { Effect, Result } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  parseSshEndpoint,
  parseRemoteUnixSocketPath,
  remoteHermesCli,
  remoteHostProbe,
  remoteUname,
  type OneShotProgram,
  type ScopedStreamProgram,
} from "../src/main/vellum/ssh";
import {
  makeRemoteCommand,
  makeRemoteStdin,
} from "../src/main/vellum/ssh/domain";
import {
  oneShot,
} from "../src/main/vellum/ssh/program";

describe("SSH domain", () => {
  it("accepts option-safe SSH aliases and rejects option injection", async () => {
    const valid = await Effect.runPromise(parseSshEndpoint("ops@remote-a"));
    const invalid = await Effect.runPromise(Effect.result(parseSshEndpoint("-oProxyCommand=boom")));

    expect(valid).toBe("ops@remote-a");
    expect(Result.isFailure(invalid)).toBe(true);
  });

  it("rejects NUL-bearing remote arguments before policy compilation", async () => {
    const result = await Effect.runPromise(
      Effect.result(makeRemoteCommand("herdr", ["session", "bad\u0000value"])),
    );

    expect(Result.isFailure(result)).toBe(true);
  });

  it("bounds the complete remote command below the local argv ceiling", async () => {
    const result = await Effect.runPromise(
      Effect.result(makeRemoteCommand("herdr", ["a".repeat(64 * 1024), "b".repeat(64 * 1024)])),
    );

    expect(Result.isFailure(result)).toBe(true);
  });

  it("makes free-form destructive sh -c unrepresentable from the product API", async () => {
    // Product surface: fixed hermes executable only — never /bin/sh.
    type ProductApi = typeof import("../src/main/vellum/ssh");
    type HasGenericMint = "makeRemoteCommand" extends keyof ProductApi ? true : false;
    expectTypeOf<HasGenericMint>().toEqualTypeOf<false>();

    const probe = await Effect.runPromise(
      Effect.result(
        remoteHostProbe(["/bin/sh", "-c", "rm -rf -- /"]),
      ),
    );
    expect(Result.isFailure(probe)).toBe(true);

    // remoteHermesCli cannot redirect the executable to a shell.
    const hermes = await Effect.runPromise(remoteHermesCli(["version"]));
    expect(hermes).toBeDefined();
    const uname = await Effect.runPromise(remoteUname());
    expect(uname).toBeDefined();
  });

  it("bounds Unix socket paths by encoded bytes", async () => {
    const overLimit = `/${"é".repeat(52)}`;
    const result = await Effect.runPromise(Effect.result(parseRemoteUnixSocketPath(overLimit)));

    expect(Result.isFailure(result)).toBe(true);
  });

  it("rejects OpenSSH forwarding metacharacters in remote socket paths", async () => {
    for (const path of [
      "/tmp/a:b.sock",
      "/tmp/%h.sock",
      "/tmp/a\\b.sock",
      "/tmp/a\nsock",
    ]) {
      const result = await Effect.runPromise(
        Effect.result(parseRemoteUnixSocketPath(path)),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
  });

  it("keeps one-shot and scoped-stream programs nominally disjoint", () => {
    expectTypeOf<OneShotProgram>().not.toEqualTypeOf<ScopedStreamProgram>();

    // @ts-expect-error SSH programs are opaque and cannot be forged by callers.
    const forged: OneShotProgram = {};
    expect(forged).toEqual({});
  });

  it("requires opaque commands and stdin at every operation boundary", async () => {
    const endpoint = await Effect.runPromise(parseSshEndpoint("remote-a"));
    const input = await Effect.runPromise(makeRemoteStdin("sensitive body"));

    // @ts-expect-error raw shell text cannot be used as a remote command.
    const rawProgram: OneShotProgram = oneShot(endpoint, "rm -rf /tmp/example");
    // @ts-expect-error remote stdin cannot be structurally forged.
    const forgedInput: typeof input = {};

    expect(rawProgram).toBeDefined();
    expect(forgedInput).toEqual({});
  });

  it("does not expose generic remote command or transport-topology constructors", () => {
    type PublicSsh = typeof import("../src/main/vellum/ssh");
    type HasGenericCommand = "makeRemoteCommand" extends keyof PublicSsh ? true : false;
    type HasGenericStdin = "makeRemoteStdin" extends keyof PublicSsh ? true : false;
    type HasOneShot = "oneShot" extends keyof PublicSsh ? true : false;
    type HasDedicatedStream = "dedicatedStream" extends keyof PublicSsh ? true : false;
    type HasDarwinFreeform =
      "compileDarwinRemoteDeployScript" extends keyof PublicSsh ? true : false;

    expectTypeOf<HasGenericCommand>().toEqualTypeOf<false>();
    expectTypeOf<HasGenericStdin>().toEqualTypeOf<false>();
    expectTypeOf<HasOneShot>().toEqualTypeOf<false>();
    expectTypeOf<HasDedicatedStream>().toEqualTypeOf<false>();
    expectTypeOf<HasDarwinFreeform>().toEqualTypeOf<false>();
  });
});
