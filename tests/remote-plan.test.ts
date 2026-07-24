import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { inspectRemoteCommand } from "../src/main/vellum/ssh/domain";
import {
  compileDarwinRemoteDeployScript,
  compileHerdrImageStage,
  compileLinuxReleaseBridge,
  compileLinuxRemotePreflight,
  compileLinuxRemotePreflightSource,
  compileRemotePlan,
  compileRemotePlanSource,
  compileRemoteSettingsRestore,
  compileRemoteSettingsSnapshot,
  compileRemoteSettingsStamp,
  compileRemoteTopologySealPresence,
  confineHerdrStagePath,
  confineVellumDirectory,
  confineVellumLeaf,
  HERDR_IMAGE_STAGE_DIR,
  remotePlanPathFootprint,
  remoteStationSettingsInstallPlan,
} from "../src/main/vellum/ssh/remote-plan";

const run = <A, E>(effect: Effect.Effect<A, E>): A => {
  const result = Effect.runSync(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("remote-plan confinement", () => {
  it("admits a clean home and settings leaf", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    expect(dir.value).toBe("/home/station/.vellum");
    expect(settings.value).toBe("/home/station/.vellum/settings.json");
  });

  it("rejects path traversal and shell metacharacters in home", () => {
    expect(Either.isLeft(Effect.runSync(Effect.either(confineVellumDirectory("/tmp/../etc"))))).toBe(
      true,
    );
    expect(
      Either.isLeft(Effect.runSync(Effect.either(confineVellumDirectory("/home/a;rm -rf /")))),
    ).toBe(true);
    expect(
      Either.isLeft(Effect.runSync(Effect.either(confineVellumDirectory("/home/a$(id)")))),
    ).toBe(true);
  });

  it("refuses non-allowlisted leaf basenames at the type boundary via cast", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    expect(
      Either.isLeft(
        Effect.runSync(
          Effect.either(confineVellumLeaf(dir, "evil.sh" as "settings.json")),
        ),
      ),
    ).toBe(true);
  });
});

describe("remote-station-settings-install plan", () => {
  it("compiles a deterministic footprint under .vellum only", () => {
    const dir = run(confineVellumDirectory("/Users/alice"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const plan = remoteStationSettingsInstallPlan(dir, settings);
    expect(remotePlanPathFootprint(plan)).toEqual([
      "/Users/alice/.vellum",
      "/Users/alice/.vellum/settings.json",
      "/Users/alice/.vellum/topology.key",
      "/Users/alice/.vellum/topology.seal",
    ]);
  });

  it("never emits recursive delete, bare globs, or unconfined paths", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const source = compileRemotePlanSource(
      remoteStationSettingsInstallPlan(dir, settings),
    );
    expect(source).not.toMatch(/rm\s+-r/);
    expect(source).not.toMatch(/\*\s*$/m);
    expect(source).not.toMatch(/rm\s+-rf\s+\//);
    expect(source).toContain("/home/station/.vellum/settings.json");
    expect(source).toContain("/home/station/.vellum/topology.key");
    expect(source).toContain("set -eu");
    // Seals invalidated only after successful settings write (never before).
    const writeIdx = source.indexOf("cat >");
    const sealRmIdx = source.indexOf("topology.seal");
    expect(writeIdx).toBeGreaterThan(-1);
    expect(sealRmIdx).toBeGreaterThan(writeIdx);
    // Single postcondition invalidation (not pre+post).
    expect(source.split("topology.seal").length).toBe(2);
  });

  it("compiles to a branded RemoteCommand via makeRemoteCommand", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const command = run(
      compileRemotePlan(remoteStationSettingsInstallPlan(dir, settings)),
    );
    const parts = inspectRemoteCommand(command);
    expect(parts.executable).toBe("/bin/sh");
    expect(parts.args[0]).toBe("-c");
    expect(parts.args[2]).toBe("vellum-plan:remote-station-settings-install");
    expect(parts.args[1]).toContain("set -eu");
  });

  it("refuses symlink settings path before write", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const source = compileRemotePlanSource(
      remoteStationSettingsInstallPlan(dir, settings),
    );
    expect(source).toContain("path is a symlink");
    expect(source.indexOf("path is a symlink")).toBeLessThan(
      source.indexOf("cat >"),
    );
  });
});

describe("remote settings snapshot/stamp/restore compilers", () => {
  it("snapshot embeds only confined paths and rejects free path injection", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const cmd = run(compileRemoteSettingsSnapshot(dir, settings, 65_536));
    const parts = inspectRemoteCommand(cmd);
    expect(parts.args[1]).toContain("/home/station/.vellum/settings.json");
    expect(parts.args[1]).not.toContain("$1");
    expect(parts.args[1]).not.toContain("rm -rf");
    expect(parts.args[2]).toBe("vellum-plan:remote-settings-snapshot");
  });

  it("stamp invalidates topology seals only after successful CAS write", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const cmd = run(compileRemoteSettingsStamp(dir, settings, 65_536));
    const src = inspectRemoteCommand(cmd).args[1]!;
    expect(src).toContain("topology.key");
    expect(src).toContain("topology.seal");
    expect(src).toContain("STAMPED");
    expect(src).not.toMatch(/rm\s+-rf\s+\//);
    // CAS rejection (exit 34) must occur before any seal rm.
    const firstExit34 = src.indexOf("exit 34");
    const sealRm = src.indexOf("topology.key");
    const settingsMv = src.indexOf('mv -f -- "$NEXT_TMP" "$SETTINGS"');
    expect(firstExit34).toBeGreaterThan(-1);
    expect(settingsMv).toBeGreaterThan(firstExit34);
    expect(sealRm).toBeGreaterThan(settingsMv);
    // Exactly one seal invalidation (post-write), not pre-CAS wipe.
    expect(src.split("topology.seal").length).toBe(2);
  });

  it("restore invalidates topology seals after successful restore", () => {
    const dir = run(confineVellumDirectory("/var/home/op"));
    const settings = run(confineVellumLeaf(dir, "settings.json"));
    const cmd = run(compileRemoteSettingsRestore(dir, settings, 1024));
    const src = inspectRemoteCommand(cmd).args[1]!;
    expect(src).toContain("/var/home/op/.vellum/settings.json");
    expect(src).toContain("RESTORED");
    expect(src).not.toMatch(/rm\s+-r[f\s]/);
    expect(src).toContain("topology.key");
    expect(src).toContain("topology.seal");
    // Seal wipe is after the restore mv/rm of settings.
    const restoreDone = Math.max(
      src.lastIndexOf('mv -f -- "$ORIGINAL_TMP" "$SETTINGS"'),
      src.lastIndexOf('rm -f -- "$SETTINGS"'),
    );
    const sealRm = src.indexOf("topology.seal");
    expect(restoreDone).toBeGreaterThan(-1);
    expect(sealRm).toBeGreaterThan(restoreDone);
  });

  it("topology seal presence probe is confined and binary SEALED|UNSEALED", () => {
    const dir = run(confineVellumDirectory("/home/station"));
    const cmd = run(compileRemoteTopologySealPresence(dir));
    const src = inspectRemoteCommand(cmd).args[1]!;
    expect(src).toContain("/home/station/.vellum/topology.key");
    expect(src).toContain("/home/station/.vellum/topology.seal");
    expect(src).toContain("SEALED");
    expect(src).toContain("UNSEALED");
    expect(src).not.toMatch(/rm\s+/);
  });
});

describe("linux remote preflight compiler", () => {
  it("emits V3 protocol with fixed product helper/bridge paths only", () => {
    const source = compileLinuxRemotePreflightSource();
    expect(source).toContain("LINUX_REMOTE_PREFLIGHT_V3");
    expect(source).toContain("LINUX_REMOTE_PREFLIGHT_REFUSED_V3");
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
    expect(source).toContain('private_socket "$HOME/.vellum/work/control.sock"');
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
      "commit_deploy() { :; }",
      'echo "STATION_READY pid=1 term=1 browser=1"',
      'echo "CONTROL_SOCKET_TIMEOUT" >&2',
    ].join("\n");
    const parts = inspectRemoteCommand(run(compileDarwinRemoteDeployScript(product)));
    expect(parts.executable).toBe("bash");
    expect(parts.args[0]).toBe("-lc");
    expect(parts.args[1]).toBe(product);

    const freeForm = Effect.runSync(
      Effect.either(compileDarwinRemoteDeployScript('rm -rf -- /')),
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
      expect(Either.isLeft(Effect.runSync(Effect.either(confineHerdrStagePath(bad))))).toBe(
        true,
      );
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
