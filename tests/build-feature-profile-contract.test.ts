import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_CATALOG, SHIP_FEATURES } from "../src/shared/feature-catalog";
import { standaloneControlBuild } from "../scripts/build-standalone-cli";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const cleanFeatureEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.JUNTO_FEATURE_PROFILE;
  delete environment.JUNTO_ALLOW_FEATURE_OVERRIDES;
  for (const feature of Object.values(FEATURE_CATALOG)) delete environment[feature.env];
  return environment;
};

const runBuildPreflight = (environment = cleanFeatureEnvironment()) =>
  spawnSync(
    "/bin/bash",
    [path.join(repoRoot, "scripts", "build-app.sh"), "--preflight-only"],
    { cwd: repoRoot, encoding: "utf8", env: environment },
  );

describe("packaged feature build contract", () => {
  it("admits ordinary source builds without release credentials", () => {
    const environment = cleanFeatureEnvironment();
    delete environment.JUNTO_MAC_TEAM_ID;
    delete environment.JUNTO_MAC_SIGNING_IDENTITY;
    const result = runBuildPreflight(environment);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"profile":"ship"');
  });

  it.skipIf(process.platform !== "darwin")("requires explicit signing authority before any official build", () => {
    const environment = cleanFeatureEnvironment();
    delete environment.JUNTO_MAC_TEAM_ID;
    delete environment.JUNTO_MAC_SIGNING_IDENTITY;
    const result = spawnSync("/bin/bash", [
      path.join(repoRoot, "scripts", "build-app.sh"), "--preflight-only", "--sign",
    ], { cwd: repoRoot, encoding: "utf8", env: environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("JUNTO_MAC_TEAM_ID");
  });

  it("defaults the standalone CLI compiler to explicit ship defines", () => {
    const build = standaloneControlBuild("junto");
    expect(build.profile).toBe("ship");
    expect(build.output).toBe("dist/junto");
    for (const [key, feature] of Object.entries(FEATURE_CATALOG)) {
      expect(build.featureDefines).toContain(
        `--define=${feature.define}=${JSON.stringify(SHIP_FEATURES[key as keyof typeof SHIP_FEATURES])}`,
      );
    }
  });

  it("keeps package scripts on the profile-aware standalone compiler", async () => {
    const packageJson = await readFile(path.join(repoRoot, "package.json"), "utf8");
    expect(packageJson).toContain('"cli:build": "bun scripts/build-standalone-cli.ts junto"');
    expect(packageJson).not.toContain("browser:build");
    expect(packageJson).not.toContain("station:build");
    expect(packageJson).not.toContain("content:build");
  });

  it("rejects ship deviations unless packaging receives explicit authority", () => {
    const deviation = cleanFeatureEnvironment();
    deviation.JUNTO_BROWSER = "1";
    const rejected = runBuildPreflight(deviation);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("ship feature deviation requires JUNTO_ALLOW_FEATURE_OVERRIDES=1");

    deviation.JUNTO_ALLOW_FEATURE_OVERRIDES = "1";
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
