import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { inspectRemoteCommand } from "../src/main/vellum/ssh/domain";
import * as remotePlan from "../src/main/vellum/ssh/remote-plan";
import {
  compileDarwinRemoteDeployScript,
  compileHerdrImageStage,
  compileLinuxUserlandDeploy,
  compileLinuxUserlandPreflight,
  compileLinuxUserlandPreflightSource,
  compileLinuxUserlandDeploySource,
  confineHerdrStagePath,
  HERDR_IMAGE_STAGE_DIR,
} from "../src/main/vellum/ssh/remote-plan";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

describe("remote-plan public surface", () => {
  it("contains only current runtime and deployment capabilities", () => {
    expect(Object.keys(remotePlan).sort()).toEqual([
      "HERDR_IMAGE_STAGE_DIR",
      "compileDarwinRemoteDeployScript",
      "compileHerdrImageStage",
      "compileLinuxUserlandDeploy",
      "compileLinuxUserlandDeploySource",
      "compileLinuxUserlandPreflight",
      "compileLinuxUserlandPreflightSource",
      "confineHerdrStagePath",
    ]);
  });
});

describe("linux remote preflight compiler", () => {
  it("compiles userland preflight script and keeps admin-free facts", () => {
    const source = compileLinuxUserlandPreflightSource();
    expect(source).toContain("LINUX_USERLAND_PREFLIGHT_V1");
    expect(source).toContain("umask 077");
    expect(source).toContain("systemctl --user");
    expect(source).not.toContain("sudo");
    expect(source).not.toContain("/usr/libexec/vellum-release-installer");
    expect(source).not.toContain("/usr/libexec/vellum-release-bridge");
  });

  it("compiles to a branded RemoteCommand with plan argv label", () => {
    const command = run(compileLinuxUserlandPreflight());
    const parts = inspectRemoteCommand(command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:linux-userland-preflight");
    expect(parts.args[1]).toBe(compileLinuxUserlandPreflightSource());
  });
});

describe("named deploy compilers", () => {
  it("compiles a userland deploy command with a fixed invocation", () => {
    const parts = inspectRemoteCommand(run(compileLinuxUserlandDeploy()));
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:linux-userland-deploy");
    expect(parts.args[1]).toBe(compileLinuxUserlandDeploySource());
  });

  it("hardens deploy around vellum-command-remote generation pin, sealed install, and member proof", () => {
    const source = compileLinuxUserlandDeploySource();
    expect(source).toContain("resources/bin/vellum-command-remote");
    expect(source).not.toContain("--vellum-state-preflight");
    expect(source).toContain("--install-user-service");
    expect(source).toContain("unit_pins_generation");
    expect(source).toContain("prove_activation");
    expect(source).toContain('GENERATION_MARKER="releases/$VERSION-$SHA"');
    expect(source).toContain("$GENERATION_MARKER/resources/systemd/vellum-command-remote-launch");
    expect(source).toContain("$GENERATION_MARKER/resources/bin/vellum-command-remote");
    expect(source).toContain("state=idempotent");
    expect(source).toContain('"$HOME/.vellum-command/work/control.sock"');
    expect(source).toContain('"$HOME/.vellum-command/work/token"');
    expect(source).not.toContain('"$DEST/vellum"');
    expect(source).not.toContain('"$RELEASE/vellum-command"');
    expect(source).not.toMatch(/Xvfb|ozone-platform|--vellum-headless/u);
    expect(source).not.toContain("rm -rf");
    expect(source).toContain('/bin/rm -f -- "$ARCHIVE"');
    expect(source).toContain('/bin/rmdir -- "$STAGE"');
    expect(source).not.toContain('|| fail preflight');
  });

  it("admits a product Darwin deploy script and refuses free-form shell", () => {
    const product = [
      "begin_candidate_activation() { :; }",
      'echo "UNBOUND_DEPLOY_PATH_PRESENT" >&2',
      "IN_STATION_EXE=/fixed",
      'echo "STATION_READY pid=1 term=1 browser=1"',
      'echo "CONTROL_SOCKET_TIMEOUT" >&2',
    ].join("\n");
    const parts = inspectRemoteCommand(
      run(compileDarwinRemoteDeployScript(product)),
    );
    expect(parts.executable).toBe("/bin/bash");
    expect(parts.args[0]).toBe("-lc");
    expect(parts.args[1]).toBe(product);

    const freeForm = Effect.runSync(
      Effect.result(compileDarwinRemoteDeployScript("rm -rf -- /")),
    );
    expect(Result.isFailure(freeForm)).toBe(true);
  });
});

describe("herdr image stage plan", () => {
  const productName = "vellum-clip-lk9abc12-deadbeef.png";

  it("admits product basenames under the fixed stage root", () => {
    expect(run(confineHerdrStagePath(productName))).toBe(
      `${HERDR_IMAGE_STAGE_DIR}/${productName}`,
    );
  });

  it("rejects free-form, traversal, and shell-metachar basenames", () => {
    for (const bad of [
      "../etc/passwd",
      "evil.png",
      "vellum-clip-x-deadbeef.sh",
      "vellum-clip-x-deadbeef.png;rm",
      "vellum-clip-x-$(id)-deadbeef.png",
      "vellum-clip-x-deadbeef.png/../y",
      "",
    ]) {
      expect(
        Result.isFailure(
          Effect.runSync(Effect.result(confineHerdrStagePath(bad))),
        ),
      ).toBe(true);
    }
  });

  it("compiles a branded plan with umask, exclusive write, and no hand path args", () => {
    const staged = run(compileHerdrImageStage(productName));
    const parts = inspectRemoteCommand(staged.command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:herdr-image-stage");
    const src = parts.args[1]!;
    expect(src).toContain("set -eu");
    expect(src).toContain("umask 077");
    expect(src).toContain(HERDR_IMAGE_STAGE_DIR);
    expect(src).toContain(productName);
        expect(src).toContain("chmod 600");
    expect(src).not.toMatch(/rm\s+-rf\s+\//);
    expect(src).not.toContain("$1");
    expect(src).not.toContain("$2");
    expect(staged.path).toBe(`${HERDR_IMAGE_STAGE_DIR}/${productName}`);
  });
});
