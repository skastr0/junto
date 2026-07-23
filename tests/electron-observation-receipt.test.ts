import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOfficialElectronSources,
  validateCheckedInElectronPolicy,
} from "../scripts/electron-security-policy";

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
      schemaVersion: 1,
      policyVersion: "43.2.0",
      policyHash: createHash("sha256").update(policy).digest("hex"),
      disposition: "current",
      overdue: false,
    });
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-24T00:00:00.000Z"))).resolves.toBeUndefined();

    await writeFile(receiptPath, JSON.stringify({ ...persisted, policyHash: "tampered" }));
    await expect(validateCheckedInElectronPolicy(new Date("2026-07-24T00:00:00.000Z")))
      .rejects.toThrow(/recorded Electron observation is stale, malformed, or mismatched/u);
  });
});
