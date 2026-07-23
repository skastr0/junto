import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOfficialElectronSources,
  validateElectronArtifactPath,
  validateCheckedInElectronPolicy,
} from "../scripts/electron-security-policy";
import { electronSecurityPolicyHealthy } from "../src/main/vellum/electron-security-health";

const SUPPORT_URL = "https://www.electronjs.org/docs/latest/tutorial/electron-timelines";
const RELEASE_INDEX_URL = "https://releases.electronjs.org/releases.json";
const AUDITED_RELEASE_URL = "https://releases.electronjs.org/release/v43.2.0";

const stateDirectories: string[] = [];

const installCurrentReleaseSources = () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url === SUPPORT_URL) return new Response("Electron supports the latest 3 stable releases.");
    if (url === RELEASE_INDEX_URL) {
      return Response.json([
        { version: "41.0.0", fullDate: "2026-06-01T00:00:00.000Z" },
        { version: "42.0.0", fullDate: "2026-07-01T00:00:00.000Z" },
        { version: "43.2.0", fullDate: "2026-07-21T16:00:22.000Z" },
      ]);
    }
    if (url === AUDITED_RELEASE_URL) return new Response("audited release");
    return new Response("unexpected official source", { status: 404 });
  }));
};

describe("Electron observation receipt", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(stateDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("admits a missing receipt as the offline baseline, then rejects a tampered persisted observation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vellum-electron-observation-"));
    stateDirectories.push(directory);
    vi.stubEnv("VELLUM_RELEASE_SECURITY_STATE_DIR", directory);

    await expect(validateCheckedInElectronPolicy(new Date("2026-07-24T00:00:00.000Z"))).resolves.toBeUndefined();

    installCurrentReleaseSources();
    await checkOfficialElectronSources(new Date("2026-07-24T00:00:00.000Z"));

    const receiptPath = path.join(directory, "electron-observation.json");
    const persisted = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const policy = await readFile(new URL("../scripts/electron-security-policy.json", import.meta.url), "utf8");
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      policyVersion: "43.2.0",
      policyHash: createHash("sha256").update(policy).digest("hex"),
      disposition: "current",
      overdue: false,
    });
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-24T00:00:00.000Z"))).resolves.toBeUndefined();

    await writeFile(receiptPath, JSON.stringify({ ...persisted, policyHash: "tampered" }));
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-24T00:00:00.000Z")))
      .rejects.toThrow(/observation has an invalid shape/u);
  });

  it("cannot replay an authentic current receipt after a later EOL observation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vellum-electron-replay-"));
    stateDirectories.push(directory);
    vi.stubEnv("VELLUM_RELEASE_SECURITY_STATE_DIR", directory);

    installCurrentReleaseSources();
    await checkOfficialElectronSources(new Date("2026-07-24T00:00:00.000Z"));
    const receiptPath = path.join(directory, "electron-observation.json");
    const oldCurrent = await readFile(receiptPath, "utf8");
    const highWaterPath = path.join(directory, "electron-observation-high-water.json");
    const oldHighWater = await readFile(highWaterPath, "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === SUPPORT_URL) return new Response("Electron supports the latest 3 stable releases.");
      if (url === RELEASE_INDEX_URL) return Response.json([
        { version: "43.2.0", fullDate: "2026-07-21T16:00:22.000Z" },
        { version: "44.0.0", fullDate: "2026-07-22T00:00:00.000Z" },
        { version: "45.0.0", fullDate: "2026-07-22T01:00:00.000Z" },
        { version: "46.0.0", fullDate: "2026-07-22T02:00:00.000Z" },
      ]);
      if (url === AUDITED_RELEASE_URL) return new Response("audited release");
      return new Response("unexpected official source", { status: 404 });
    }));
    await checkOfficialElectronSources(new Date("2026-07-25T00:00:00.000Z"));
    expect(electronSecurityPolicyHealthy({
      policyPath: path.resolve("scripts/electron-security-policy.json"),
      electronVersion: "43.2.0",
      observationPath: receiptPath,
      observationHighWaterPath: highWaterPath,
      now: new Date("2026-07-25T00:00:00.000Z"),
    })).toBe(false);
    await writeFile(receiptPath, oldCurrent);
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-25T00:00:00.000Z")))
      .rejects.toThrow(/current high-water state/u);
    await writeFile(highWaterPath, oldHighWater);
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-25T00:00:00.000Z")))
      .rejects.toThrow(/adverse observation survives/u);
    await unlink(receiptPath);
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-25T00:00:00.000Z")))
      .rejects.toThrow(/ENOENT|no such file/u);
    installCurrentReleaseSources();
    await expect(checkOfficialElectronSources(new Date("2026-07-26T00:00:00.000Z")))
      .rejects.toThrow(/irreversible/u);
  });

  it("rejects an existing world-writable state directory instead of repairing it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vellum-electron-private-"));
    stateDirectories.push(directory);
    vi.stubEnv("VELLUM_RELEASE_SECURITY_STATE_DIR", directory);
    await chmod(directory, 0o777);
    installCurrentReleaseSources();
    await expect(checkOfficialElectronSources(new Date("2026-07-24T00:00:00.000Z")))
      .rejects.toThrow(/owner-owned non-symlink private directory/u);
  });

  it("rejects an artifact whose embedded current receipt predates local adverse state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vellum-electron-artifact-"));
    stateDirectories.push(directory);
    vi.stubEnv("VELLUM_RELEASE_SECURITY_STATE_DIR", directory);
    installCurrentReleaseSources();
    await checkOfficialElectronSources(new Date("2026-07-24T00:00:00.000Z"));
    const artifact = path.join(directory, "artifact");
    const policyDirectory = path.join(artifact, "resources", "policy");
    await mkdir(policyDirectory, { recursive: true });
    await copyFile(path.resolve("scripts/electron-security-policy.json"), path.join(policyDirectory, "electron-security-policy.json"));
    await copyFile(path.join(directory, "electron-observation.json"), path.join(policyDirectory, "electron-observation.json"));
    await copyFile(path.join(directory, "electron-observation-high-water.json"), path.join(policyDirectory, "electron-observation-high-water.json"));
    await writeFile(path.join(artifact, "version"), "43.2.0\n");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === SUPPORT_URL) return new Response("Electron supports the latest 3 stable releases.");
      if (url === RELEASE_INDEX_URL) return Response.json([{ version: "43.2.0", fullDate: "2026-07-21T16:00:22.000Z" }, { version: "44.0.0", fullDate: "2026-07-22T00:00:00.000Z" }, { version: "45.0.0", fullDate: "2026-07-22T01:00:00.000Z" }, { version: "46.0.0", fullDate: "2026-07-22T02:00:00.000Z" }]);
      if (url === AUDITED_RELEASE_URL) return new Response("audited release");
      return new Response("unexpected official source", { status: 404 });
    }));
    await checkOfficialElectronSources(new Date("2026-07-25T00:00:00.000Z"));
    await expect(validateElectronArtifactPath(artifact, new Date("2026-07-25T00:00:00.000Z")))
      .rejects.toThrow(/adverse observation/u);
  });
});
