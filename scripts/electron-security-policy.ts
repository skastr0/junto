/**
 * Offline Electron release-freshness gate.
 *
 * The checked-in policy is the sole build trust root. `check` fetches official
 * Electron sources for an operator report, but deliberately never writes it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "scripts/electron-security-policy.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const INSTALLED_PACKAGE_PATH = path.join(ROOT, "node_modules/electron/package.json");
const INSTALLED_RUNTIME_PATH = path.join(ROOT, "node_modules/electron/dist/version");
const SUPPORT_URL = "https://www.electronjs.org/docs/latest/tutorial/electron-timelines";
const RELEASE_INDEX_URL = "https://releases.electronjs.org/releases.json";

export interface ElectronSecurityPolicy {
  readonly schemaVersion: 1;
  readonly reviewedAt: string;
  readonly expiresAt: string;
  readonly reviewSla: { readonly routineDays: number; readonly urgentHours: number };
  readonly electron: {
    readonly exactVersion: string;
    readonly minimumSupportedMajor: number;
    readonly currentSupportedMajors: readonly number[];
    readonly auditedRelease: { readonly version: string; readonly publishedAt: string; readonly url: string };
  };
  readonly provenance: readonly { readonly url: string; readonly purpose: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(`electron security policy: ${message}`); };
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${expected.join(", ")}`);
  }
};
const versionParts = (version: string, label: string) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`${label} must be a canonical x.y.z version`);
  return match!.slice(1).map(Number) as [number, number, number];
};
const date = (value: string, label: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`${label} must be canonical ISO-8601 UTC`);
  return parsed;
};
const officialUrl = (value: string, label: string) => {
  let url: URL | undefined;
  try { url = new URL(value); } catch { fail(`${label} must be an absolute URL`); }
  if (!url) fail(`${label} must be an absolute URL`);
  const parsed = url as URL;
  if (parsed.protocol !== "https:" || (parsed.hostname !== "www.electronjs.org" && parsed.hostname !== "releases.electronjs.org")) {
    fail(`${label} must be an official Electron HTTPS URL`);
  }
};

export const decodeElectronSecurityPolicy = (input: unknown): ElectronSecurityPolicy => {
  if (!isRecord(input)) fail("must be an object");
  const policy = input as Record<string, unknown>;
  exactKeys(policy, ["electron", "expiresAt", "provenance", "reviewSla", "reviewedAt", "schemaVersion"], "policy");
  if (policy.schemaVersion !== 1 || typeof policy.reviewedAt !== "string" || typeof policy.expiresAt !== "string" || !isRecord(policy.reviewSla) || !isRecord(policy.electron) || !Array.isArray(policy.provenance)) fail("has an invalid shape");
  const reviewSla = policy.reviewSla as Record<string, unknown>;
  exactKeys(reviewSla, ["routineDays", "urgentHours"], "reviewSla");
  const routineDays = reviewSla.routineDays;
  const urgentHours = reviewSla.urgentHours;
  if (!Number.isInteger(routineDays) || (routineDays as number) <= 0 || !Number.isInteger(urgentHours) || (urgentHours as number) <= 0) fail("review SLAs must be positive integers");
  const electron = policy.electron as Record<string, unknown>;
  exactKeys(electron, ["auditedRelease", "currentSupportedMajors", "exactVersion", "minimumSupportedMajor"], "electron");
  if (typeof electron.exactVersion !== "string" || !Number.isInteger(electron.minimumSupportedMajor) || !Array.isArray(electron.currentSupportedMajors) || !isRecord(electron.auditedRelease)) fail("electron has an invalid shape");
  const auditedRelease = electron.auditedRelease as Record<string, unknown>;
  exactKeys(auditedRelease, ["publishedAt", "url", "version"], "auditedRelease");
  if (typeof auditedRelease.version !== "string" || typeof auditedRelease.publishedAt !== "string" || typeof auditedRelease.url !== "string") fail("auditedRelease has an invalid shape");
  const sources = policy.provenance as unknown[];
  if (sources.length < 3 || !sources.every(isRecord)) fail("must retain all official provenance");
  const provenance = (sources as Record<string, unknown>[]).map((source) => {
    exactKeys(source, ["purpose", "url"], "provenance source");
    const url = source.url;
    const purpose = source.purpose;
    if (typeof url !== "string" || typeof purpose !== "string" || purpose.length === 0) fail("provenance source has an invalid shape");
    officialUrl(url as string, "provenance URL");
    return { url: url as string, purpose: purpose as string };
  });
  return { schemaVersion: 1, reviewedAt: policy.reviewedAt as string, expiresAt: policy.expiresAt as string, reviewSla: reviewSla as ElectronSecurityPolicy["reviewSla"], electron: { exactVersion: electron.exactVersion as string, minimumSupportedMajor: electron.minimumSupportedMajor as number, currentSupportedMajors: electron.currentSupportedMajors as number[], auditedRelease: auditedRelease as ElectronSecurityPolicy["electron"]["auditedRelease"] }, provenance };
};

export const validateElectronSecurityPolicy = (policy: ElectronSecurityPolicy, input: { readonly now: Date; readonly manifestVersion: string; readonly installedPackageVersion: string; readonly installedRuntimeVersion: string }) => {
  const reviewedAt = date(policy.reviewedAt, "reviewedAt");
  const expiresAt = date(policy.expiresAt, "expiresAt");
  if (expiresAt <= reviewedAt || input.now.getTime() >= expiresAt) fail(`expired at ${policy.expiresAt}`);
  const exact = versionParts(policy.electron.exactVersion, "electron.exactVersion");
  const audited = versionParts(policy.electron.auditedRelease.version, "auditedRelease.version");
  date(policy.electron.auditedRelease.publishedAt, "auditedRelease.publishedAt");
  officialUrl(policy.electron.auditedRelease.url, "auditedRelease.url");
  if (policy.electron.exactVersion !== policy.electron.auditedRelease.version) fail("exactVersion must equal auditedRelease.version");
  const majors = policy.electron.currentSupportedMajors;
  if (majors.length !== 3 || new Set(majors).size !== majors.length || !majors.every(Number.isInteger) || !majors.every((major) => major >= policy.electron.minimumSupportedMajor) || Math.min(...majors) !== policy.electron.minimumSupportedMajor) fail("must name exactly the three current supported majors beginning at minimumSupportedMajor");
  if (!majors.includes(exact[0])) fail(`pinned major ${exact[0]} is unsupported`);
  if (!policy.provenance.some((source) => source.url === SUPPORT_URL) || !policy.provenance.some((source) => source.url === RELEASE_INDEX_URL) || !policy.provenance.some((source) => source.url === policy.electron.auditedRelease.url)) fail("is missing required official support or release provenance");
  for (const [label, value] of [["package.json", input.manifestVersion], ["installed electron package", input.installedPackageVersion], ["installed Electron runtime", input.installedRuntimeVersion]] as const) {
    versionParts(value, label);
    if (value !== policy.electron.exactVersion) fail(`${label} is ${value}; expected audited ${policy.electron.exactVersion}`);
  }
  if (audited.join(".") !== exact.join(".")) fail("installed artifact is older than the audited release");
};

const readVersion = async (filename: string, field?: string): Promise<string> => {
  const raw = await readFile(filename, "utf8");
  if (!field) return raw.trim();
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const value = parsed[field];
  if (typeof value !== "string") fail(`${filename} is missing ${field}`);
  return value as string;
};
export const validateCheckedInElectronPolicy = async (now = new Date()) => {
  const [rawPolicy, installedPackageVersion, installedRuntimeVersion] = await Promise.all([
    readFile(POLICY_PATH, "utf8"), readVersion(INSTALLED_PACKAGE_PATH, "version"), readVersion(INSTALLED_RUNTIME_PATH),
  ]);
  const manifest = JSON.parse(await readFile(PACKAGE_PATH, "utf8")) as { devDependencies?: Record<string, unknown> };
  const version = manifest.devDependencies?.electron;
  if (typeof version !== "string") fail("package.json is missing devDependencies.electron");
  validateElectronSecurityPolicy(decodeElectronSecurityPolicy(JSON.parse(rawPolicy)), { now, manifestVersion: version as string, installedPackageVersion, installedRuntimeVersion });
};

export const checkOfficialElectronSources = async () => {
  const policy = decodeElectronSecurityPolicy(JSON.parse(await readFile(POLICY_PATH, "utf8")));
  const [support, releases, release] = await Promise.all([
    fetch(SUPPORT_URL), fetch(RELEASE_INDEX_URL), fetch(policy.electron.auditedRelease.url),
  ]);
  if (!support.ok || !releases.ok || !release.ok) fail(`official refresh failed: support=${support.status} releases=${releases.status} release=${release.status}`);
  const list = await releases.json() as unknown;
  if (!Array.isArray(list) || !list.some((entry) => isRecord(entry) && entry.version === policy.electron.auditedRelease.version)) fail(`official release index does not contain ${policy.electron.auditedRelease.version}`);
  return { checkedAt: new Date().toISOString(), policyVersion: policy.electron.exactVersion, sources: [SUPPORT_URL, RELEASE_INDEX_URL, policy.electron.auditedRelease.url] };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "validate" && process.argv.length === 3) {
    await validateCheckedInElectronPolicy();
    console.log("electron security policy: valid (offline)");
  } else if (command === "check" && process.argv.length === 3) {
    console.log(JSON.stringify(await checkOfficialElectronSources(), null, 2));
  } else {
    console.error("usage: bun scripts/electron-security-policy.ts validate|check");
    process.exitCode = 1;
  }
}
