import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { inspectRemoteCommand } from "../src/main/vellum/ssh/domain";
import {
  compileRemotePlan,
  compileRemotePlanSource,
  confineVellumDirectory,
  confineVellumLeaf,
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
    // Seals invalidated before and after write.
    expect(source.split("topology.seal").length).toBeGreaterThan(2);
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
