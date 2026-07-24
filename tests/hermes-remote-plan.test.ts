import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  parseHermesProfileName,
  type HermesProfileName,
} from "../src/main/vellum/hermes/domain";
import { inspectRemoteCommand } from "../src/main/vellum/ssh/domain";
import {
  compileHermesAvatar,
  compileHermesIdentityBatch,
  hermesAvatarSource,
  hermesIdentityBatchSource,
} from "../src/main/vellum/ssh/hermes-remote-plan";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("hermes identity-batch compiler", () => {
  it("compiles a branded /bin/sh RemoteCommand with fixed product name", () => {
    const command = run(compileHermesIdentityBatch());
    const parts = inspectRemoteCommand(command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:hermes-identity-batch");
    expect(parts.args).toHaveLength(3);
  });

  it("enumerates $HOME/.hermes and profiles without free-form path injection", () => {
    const source = hermesIdentityBatchSource();
    expect(source).toContain("$HOME/.hermes");
    expect(source).toContain("identity-brief.md");
    expect(source).toContain("MATRIX_USER_ID=");
    expect(source).toContain("profile-picture.png");
    expect(source).not.toContain("rm -rf");
    expect(source).not.toMatch(/\$\{/);
  });

  it("keeps tab-separated emit shape for parseIdentityBatchLine", () => {
    const source = hermesIdentityBatchSource();
    expect(source).toContain("printf '%s\\t%s\\t%s\\t%s\\t%s\\n'");
  });
});

describe("hermes avatar compiler", () => {
  it("passes branded profile as argv only — never interpolates into shell", () => {
    const profile = parseHermesProfileName("profile-13")!;
    const command = run(compileHermesAvatar(profile));
    const parts = inspectRemoteCommand(command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:hermes-avatar");
    expect(parts.args[3]).toBe("profile-13");
    expect(parts.args[1]).not.toContain("profile-13");
    expect(parts.args[1]).toContain('"$1"');
  });

  it("avatar source resolves default vs named under $HOME/.hermes only", () => {
    const source = hermesAvatarSource();
    expect(source).toContain("$HOME/.hermes/assets/profile-picture.png");
    expect(source).toContain("$HOME/.hermes/profiles/$1/assets/profile-picture.png");
    expect(source).toContain("exec base64");
    expect(source).not.toContain("rm ");
  });

  it("rejects a forged profile brand that fails shape re-admission", () => {
    const forged = "evil;rm -rf /" as HermesProfileName;
    const result = Effect.runSync(Effect.either(compileHermesAvatar(forged)));
    expect(Either.isLeft(result)).toBe(true);
  });
});
