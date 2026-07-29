import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { inspectRemoteCommand } from "../src/main/vellum/ssh/domain";
import * as remotePlan from "../src/main/vellum/ssh/remote-plan";
import {
  compileDarwinRemoteDeployScript,
  compileHerdrImageStage,
  compileLinuxReleaseBridge,
  compileLinuxRemotePreflight,
  compileLinuxRemotePreflightSource,
  confineHerdrStagePath,
  HERDR_IMAGE_STAGE_DIR,
} from "../src/main/vellum/ssh/remote-plan";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("remote-plan public surface", () => {
  it("contains only current runtime and deployment capabilities", () => {
    expect(Object.keys(remotePlan).sort()).toEqual([
      "HERDR_IMAGE_STAGE_DIR",
      "compileDarwinRemoteDeployScript",
      "compileHerdrImageStage",
      "compileLinuxFirstInstall",
      "compileLinuxFirstInstallSource",
      "compileLinuxReleaseBridge",
      "compileLinuxRemotePreflight",
      "compileLinuxRemotePreflightSource",
      "compileLinuxRemoteUnitActivate",
      "compileLinuxRemoteUnitActivateSource",
      "confineHerdrStagePath",
    ]);
  });
});

describe("linux remote preflight compiler", () => {
  it("emits V4 protocol with fixed product helper/bridge paths only", () => {
    const source = compileLinuxRemotePreflightSource();
    expect(source).toContain("LINUX_REMOTE_PREFLIGHT_V4");
    expect(source).toContain("LINUX_REMOTE_PREFLIGHT_REFUSED_V4");
    expect(source).toContain("installerState=");
    expect(source).toContain("/var/lib/vellum-release-installer");
    expect(source).toContain("/usr/libexec/vellum-release-installer");
    expect(source).toContain("/usr/libexec/vellum-release-bridge");
    expect(source).toContain(
      'READY_RECEIPT="/run/user/$UID_VALUE/vellum-remote/ready-$INVOCATION"',
    );
    expect(source).toContain(
      '[ "$(/usr/bin/wc -c < "$READY_RECEIPT" 2>/dev/null | /usr/bin/tr -d \' \')" = 33 ]',
    );
    expect(source).toContain(
      '/usr/bin/printf \'%s\\n\' "$INVOCATION" | /usr/bin/cmp -s - "$READY_RECEIPT"',
    );
    expect(source).not.toContain(
      '[ "$(/usr/bin/cat "$READY_RECEIPT" 2>/dev/null || true)" = "$INVOCATION" ]',
    );
    expect(source).toContain("/usr/bin/cmp");
    expect(source).toContain("/usr/bin/wc");
    expect(source).toContain(
      'private_socket "$HOME/.vellum/work/control.sock"',
    );
    expect(source).toContain('private_file "$HOME/.vellum/work/token"');
    expect(source).not.toContain("station_ready_receipt");
    expect(source).not.toContain("station-ready.json");
    expect(source).not.toContain("python3");
    expect(source).not.toContain(
      'private_socket "$HOME/.vellum/term/control.sock"',
    );
    expect(source).not.toContain(
      'private_socket "$HOME/.vellum/browser/control.sock"',
    );
    // Named program: no recursive wipe or mktemp staging.
    expect(source).not.toMatch(/rm\s+-rf\s+\//);
    expect(source).not.toContain("mktemp");
  });

  it("compiles to a branded RemoteCommand with plan argv label", () => {
    const command = run(compileLinuxRemotePreflight());
    const parts = inspectRemoteCommand(command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:linux-remote-preflight");
    expect(parts.args[1]).toBe(compileLinuxRemotePreflightSource());
  });
});

describe("named deploy compilers", () => {
  it("compiles the fixed linux release bridge with no argv", () => {
    const parts = inspectRemoteCommand(run(compileLinuxReleaseBridge()));
    expect(parts.executable).toBe("/usr/libexec/vellum-release-bridge");
    expect(parts.args).toEqual([]);
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
      Effect.either(compileDarwinRemoteDeployScript("rm -rf -- /")),
    );
    expect(Either.isLeft(freeForm)).toBe(true);
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
        Either.isLeft(
          Effect.runSync(Effect.either(confineHerdrStagePath(bad))),
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
    expect(src).toContain("set -C");
    expect(src).toContain("chmod 600");
    expect(src).not.toMatch(/rm\s+-rf\s+\//);
    expect(src).not.toContain("$1");
    expect(src).not.toContain("$2");
    expect(staged.path).toBe(`${HERDR_IMAGE_STAGE_DIR}/${productName}`);
  });
});
