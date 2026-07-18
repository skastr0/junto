import { Effect, Either } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  makeRemoteCommand,
  parseSshEndpoint,
  parseUnixSocketPath,
  type OneShotProgram,
  type ScopedStreamProgram,
} from "../src/main/vellum/ssh";

describe("SSH domain", () => {
  it("accepts option-safe SSH aliases and rejects option injection", async () => {
    const valid = await Effect.runPromise(parseSshEndpoint("ops@remote-a"));
    const invalid = await Effect.runPromise(Effect.either(parseSshEndpoint("-oProxyCommand=boom")));

    expect(valid).toBe("ops@remote-a");
    expect(Either.isLeft(invalid)).toBe(true);
  });

  it("rejects NUL-bearing remote arguments before policy compilation", async () => {
    const result = await Effect.runPromise(
      Effect.either(makeRemoteCommand("herdr", ["session", "bad\u0000value"])),
    );

    expect(Either.isLeft(result)).toBe(true);
  });

  it("bounds Unix socket paths by encoded bytes", async () => {
    const overLimit = `/${"é".repeat(52)}`;
    const result = await Effect.runPromise(Effect.either(parseUnixSocketPath(overLimit)));

    expect(Either.isLeft(result)).toBe(true);
  });

  it("keeps one-shot and scoped-stream programs nominally disjoint", () => {
    expectTypeOf<OneShotProgram>().not.toEqualTypeOf<ScopedStreamProgram>();

    // @ts-expect-error SSH programs are opaque and cannot be forged by callers.
    const forged: OneShotProgram = {};
    expect(forged).toEqual({});
  });
});
