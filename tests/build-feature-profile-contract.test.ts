import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FEATURE_CATALOG,
  SHIP_FEATURES,
  type FeatureKey,
} from "../src/shared/feature-catalog";
import { standaloneControlBuild } from "../scripts/build-standalone-cli";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const cleanFeatureEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.VELLUM_COMMAND_FEATURE_PROFILE;
  delete environment.VELLUM_COMMAND_ALLOW_FEATURE_OVERRIDES;
  for (const feature of Object.values(FEATURE_CATALOG)) delete environment[feature.env];
  return environment;
};

const runBuildPreflight = (environment = cleanFeatureEnvironment()) =>
  spawnSync(
    "/bin/bash",
    [path.join(repoRoot, "scripts", "build-app.sh"), "--license-preflight-only"],
    { cwd: repoRoot, encoding: "utf8", env: environment },
  );

describe("packaged feature build contract", () => {
  it("defaults the standalone CLI compiler to explicit ship defines", () => {
    const build = standaloneControlBuild("vellum-command");
    expect(build.profile).toBe("ship");
    expect(build.output).toBe("dist/vellum-command");
    for (const [key, feature] of Object.entries(FEATURE_CATALOG) as Array<
      [FeatureKey, (typeof FEATURE_CATALOG)[FeatureKey]]
    >) {
      expect(build.featureDefines).toContain(
        `--define=${feature.define}=${String(SHIP_FEATURES[key])}`,
      );
    }
  });

  it("keeps package scripts on the profile-aware standalone compiler", async () => {
    const packageJson = await readFile(path.join(repoRoot, "package.json"), "utf8");
    expect(packageJson).toContain('"cli:build": "bun scripts/build-standalone-cli.ts vellum-command"');
    expect(packageJson).not.toContain("browser:build");
    expect(packageJson).not.toContain("station:build");
    expect(packageJson).not.toContain("content:build");
  });

  it("rejects ship deviations unless packaging receives explicit authority", () => {
    const deviation = cleanFeatureEnvironment();
    deviation.VELLUM_COMMAND_BROWSER = "1";
    const rejected = runBuildPreflight(deviation);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("ship feature deviation requires VELLUM_COMMAND_ALLOW_FEATURE_OVERRIDES=1");

    deviation.VELLUM_COMMAND_ALLOW_FEATURE_OVERRIDES = "1";
    const authorized = runBuildPreflight(deviation);
    expect(authorized.status).toBe(0);
    expect(authorized.stdout).toContain('"profile":"ship"');
    expect(authorized.stdout).toContain('"overrides":["browser"]');
  });

  it("runs ship-off gates in build verification", async () => {
    const build = await readFile(path.join(repoRoot, "scripts", "build-app.sh"), "utf8");
    const verifyBlock = build.slice(build.indexOf('if [[ "$VERIFY" -eq 1 ]]'));
    expect(verifyBlock).toContain("bun run test:features:ship");
  });
});
