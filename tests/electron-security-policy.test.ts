import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkOfficialElectronSources,
  decodeElectronSecurityPolicy,
  validateElectronSecurityPolicy,
} from "../scripts/electron-security-policy";

const SUPPORT_URL = "https://www.electronjs.org/docs/latest/tutorial/electron-timelines";
const RELEASE_INDEX_URL = "https://releases.electronjs.org/releases.json";
const AUDITED_RELEASE_URL = "https://releases.electronjs.org/release/v43.2.0";
const SCRIPT_PATH = fileURLToPath(new URL("../scripts/electron-security-policy.ts", import.meta.url));

const loadPolicy = async () => decodeElectronSecurityPolicy(JSON.parse(
  await readFile(new URL("../scripts/electron-security-policy.json", import.meta.url), "utf8"),
));

const release = (version: string, fullDate?: string) => ({
  version,
  ...(fullDate === undefined ? {} : { fullDate }),
});

const supportedReleases = (currentLine: Record<string, unknown>) => [
  release("41.0.0", "2026-06-01T00:00:00.000Z"),
  release("42.0.0", "2026-07-01T00:00:00.000Z"),
  release("43.2.0", "2026-07-21T16:00:22.000Z"),
  currentLine,
];

const mockOfficialFetch = (releases: readonly Record<string, unknown>[]) => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url === SUPPORT_URL) return new Response("Electron supports the latest 3 stable releases.");
    if (url === RELEASE_INDEX_URL) return Response.json(releases);
    if (url === AUDITED_RELEASE_URL) return new Response("audited release");
    return new Response("unexpected official source", { status: 404 });
  }));
};

const validInput = {
  now: new Date("2026-07-23T12:00:00.000Z"),
  manifestVersion: "43.2.0",
  installedPackageVersion: "43.2.0",
  installedRuntimeVersion: "43.2.0",
};

describe("Electron release-freshness policy", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "vellum-electron-policy-test-"));
    vi.stubEnv("VELLUM_RELEASE_SECURITY_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("pins the audited current release with official provenance and explicit review SLAs", async () => {
    const policy = await loadPolicy();
    expect(policy.electron).toMatchObject({
      exactVersion: "43.2.0",
      minimumSupportedMajor: 41,
      currentSupportedMajors: [41, 42, 43],
      auditedRelease: { version: "43.2.0" },
    });
    expect(policy.reviewSla).toEqual({ routineDays: 14, urgentHours: 24 });
    expect(policy.provenance.map((source) => source.url)).toEqual(expect.arrayContaining([
      "https://www.electronjs.org/docs/latest/tutorial/electron-timelines",
      "https://releases.electronjs.org/releases.json",
      "https://releases.electronjs.org/release/v43.2.0",
    ]));
    expect(() => validateElectronSecurityPolicy(policy, validInput)).not.toThrow();
  });

  it("fails closed for expired reviews, missing provenance, unsupported majors, and stale installed artifacts", async () => {
    const policy = await loadPolicy();
    expect(() => validateElectronSecurityPolicy(policy, { ...validInput, now: new Date("2026-08-06T00:00:00.000Z") })).toThrow(/expired/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, provenance: policy.provenance.slice(1) }, validInput)).toThrow(/missing required official/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, electron: { ...policy.electron, currentSupportedMajors: [40, 41, 42], minimumSupportedMajor: 40 } }, validInput)).toThrow(/unsupported/u);
    expect(() => validateElectronSecurityPolicy(policy, { ...validInput, installedRuntimeVersion: "43.1.1" })).toThrow(/expected audited 43\.2\.0/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, reviewedAt: "2026-07-24T00:00:00.000Z" }, validInput)).toThrow(/future/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, expiresAt: "2026-08-07T00:00:00.000Z" }, validInput)).toThrow(/expired/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, electron: { ...policy.electron, auditedRelease: { ...policy.electron.auditedRelease, publishedAt: "2026-07-24T00:00:00.000Z" } } }, validInput)).toThrow(/after the policy review/u);
  });

  it("rejects non-canonical policy structures and non-official provenance", () => {
    expect(() => decodeElectronSecurityPolicy({ schemaVersion: 1 })).toThrow(/keys must be exactly/u);
    expect(() => decodeElectronSecurityPolicy({
      schemaVersion: 1,
      reviewedAt: "2026-07-23T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
      reviewSla: { routineDays: 14, urgentHours: 24 },
      electron: { exactVersion: "43.2.0", minimumSupportedMajor: 41, currentSupportedMajors: [41, 42, 43], auditedRelease: { version: "43.2.0", publishedAt: "2026-07-21T16:00:22.000Z", url: "https://releases.electronjs.org/release/v43.2.0" } },
      provenance: [{ url: "https://example.test/releases", purpose: "forged" }, { url: "https://releases.electronjs.org/releases.json", purpose: "release index" }, { url: "https://releases.electronjs.org/release/v43.2.0", purpose: "release" }],
    })).toThrow(/official Electron HTTPS/u);
  });

  it("anchors the urgent deadline to official publication instead of observation time", async () => {
    mockOfficialFetch(supportedReleases(release("43.2.1", "2026-07-23T10:00:00.000Z")));

    const first = await checkOfficialElectronSources(new Date("2026-07-23T20:00:00.000Z"));
    const rerun = await checkOfficialElectronSources(new Date("2026-07-24T09:59:59.999Z"));

    expect(first).toMatchObject({
      disposition: "newer_patch_available",
      currentLinePatch: "43.2.1",
      dueAt: "2026-07-24T10:00:00.000Z",
      overdue: false,
    });
    expect(rerun.dueAt).toBe(first.dueAt);
    expect(rerun.overdue).toBe(false);
  });

  it("marks an unreconciled patch overdue at its publication-based deadline", async () => {
    mockOfficialFetch(supportedReleases(release("43.2.1", "2026-07-23T10:00:00.000Z")));

    const receipt = await checkOfficialElectronSources(new Date("2026-07-24T10:00:00.001Z"));

    expect(receipt).toMatchObject({
      disposition: "newer_patch_available",
      dueAt: "2026-07-24T10:00:00.000Z",
      overdue: true,
    });
  });

  it("returns an overdue EOL disposition that can never be mistaken for current", async () => {
    mockOfficialFetch([
      release("43.2.0", "2026-07-21T16:00:22.000Z"),
      release("44.0.0", "2026-07-21T17:00:00.000Z"),
      release("45.0.0", "2026-07-21T18:00:00.000Z"),
      release("46.0.0", "2026-07-21T19:00:00.000Z"),
    ]);

    const receipt = await checkOfficialElectronSources(new Date("2026-07-21T20:00:00.000Z"));

    expect(receipt).toMatchObject({
      disposition: "eol",
      eol: true,
      overdue: true,
      supportedMajors: [44, 45, 46],
    });
    expect(receipt.disposition).not.toBe("current");
  });

  it.each([
    ["missing", release("43.2.1")],
    ["malformed", release("43.2.1", "July 23, 2026")],
  ])("fails closed when the newest current-line release has a %s publication date", async (_label, currentLine) => {
    mockOfficialFetch(supportedReleases(currentLine));

    await expect(checkOfficialElectronSources(new Date("2026-07-23T20:00:00.000Z")))
      .rejects.toThrow(/publication date|canonical ISO-8601 UTC/u);
  });

  it("maps overdue patch and EOL receipts to a nonzero CLI gate", async () => {
    const originalArgv = [...process.argv];
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"));

    try {
      mockOfficialFetch(supportedReleases(release("43.2.1", "2026-07-23T10:00:00.000Z")));
      process.argv.splice(0, process.argv.length, process.execPath, SCRIPT_PATH, "check");
      process.exitCode = 0;
      // @ts-expect-error Vitest uses the query to instantiate the CLI module.
      await import("../scripts/electron-security-policy.ts?cli-overdue-patch");
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        disposition: "newer_patch_available",
        overdue: true,
      });

      mockOfficialFetch([
        release("43.2.0", "2026-07-21T16:00:22.000Z"),
        release("44.0.0", "2026-07-21T17:00:00.000Z"),
        release("45.0.0", "2026-07-21T18:00:00.000Z"),
        release("46.0.0", "2026-07-21T19:00:00.000Z"),
      ]);
      process.exitCode = 0;
      // @ts-expect-error Vitest uses the query to instantiate the CLI module.
      await import("../scripts/electron-security-policy.ts?cli-eol");
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        disposition: "eol",
        overdue: true,
      });
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      process.exitCode = originalExitCode;
      log.mockRestore();
    }
  });
});
