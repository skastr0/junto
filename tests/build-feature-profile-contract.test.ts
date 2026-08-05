import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_CATALOG } from "../src/shared/feature-catalog";
import { standaloneControlBuild } from "../scripts/build-standalone-cli";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const cleanFeatureEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.VELLUM_FEATURE_PROFILE;
  delete environment.VELLUM_ALLOW_FEATURE_OVERRIDES;
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
  it("defaults every standalone control compiler to explicit ship defines", () => {
    const controls = ["vellum", "browser", "station", "content"] as const;
    for (const control of controls) {
      const build = standaloneControlBuild(control);
      expect(build.profile).toBe("ship");
      for (const feature of Object.values(FEATURE_CATALOG)) {
        expect(build.featureDefines).toContain(`--define=${feature.define}=false`);
      }
    }
  });

  it("keeps package scripts on the profile-aware standalone compiler", async () => {
    const packageJson = await readFile(path.join(repoRoot, "package.json"), "utf8");
    expect(packageJson).toContain('"cli:build": "bun scripts/build-standalone-cli.ts vellum"');
    expect(packageJson).toContain('"browser:build": "bun scripts/build-standalone-cli.ts browser"');
    expect(packageJson).toContain('"station:build": "bun scripts/build-standalone-cli.ts station"');
    expect(packageJson).toContain('"content:build": "bun scripts/build-standalone-cli.ts content"');
  });

  it("rejects ship deviations unless packaging receives explicit authority", () => {
    const deviation = cleanFeatureEnvironment();
    deviation.VELLUM_BROWSER = "1";
    const rejected = runBuildPreflight(deviation);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("ship feature deviation requires VELLUM_ALLOW_FEATURE_OVERRIDES=1");

    deviation.VELLUM_ALLOW_FEATURE_OVERRIDES = "1";
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
