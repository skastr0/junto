/**
 * Offline Electron release-freshness gate.
 *
 * The checked-in policy is the sole build trust root. `check` fetches official
 * Electron sources for an operator report, but deliberately never writes it.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "scripts/electron-security-policy.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const INSTALLED_PACKAGE_PATH = path.join(ROOT, "node_modules/electron/package.json");
const INSTALLED_RUNTIME_PATH = path.join(ROOT, "node_modules/electron/dist/version");
const SUPPORT_URL = "https://www.electronjs.org/docs/latest/tutorial/electron-timelines";
const RELEASE_INDEX_URL = "https://releases.electronjs.org/releases.json";
const observationPath = () => path.join(process.env.VELLUM_RELEASE_SECURITY_STATE_DIR ?? path.join(homedir(), ".vellum", "release-security"), "electron-observation.json");
const packagedObservationPath = path.join(ROOT, "build", "electron-observation.json");
const policyHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

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
  if (reviewedAt > input.now.getTime()) fail(`reviewedAt ${policy.reviewedAt} is in the future`);
  if (expiresAt <= reviewedAt || expiresAt > reviewedAt + policy.reviewSla.routineDays * 86_400_000 || input.now.getTime() >= expiresAt) fail(`expired at ${policy.expiresAt}`);
  const exact = versionParts(policy.electron.exactVersion, "electron.exactVersion");
  const audited = versionParts(policy.electron.auditedRelease.version, "auditedRelease.version");
  const publishedAt = date(policy.electron.auditedRelease.publishedAt, "auditedRelease.publishedAt");
  if (publishedAt > reviewedAt) fail("audited release was published after the policy review");
  officialUrl(policy.electron.auditedRelease.url, "auditedRelease.url");
  if (policy.electron.exactVersion !== policy.electron.auditedRelease.version) fail("exactVersion must equal auditedRelease.version");
  const majors = policy.electron.currentSupportedMajors;
  const latestMajor = Math.max(...majors);
  if (majors.length !== 3 || new Set(majors).size !== majors.length || !majors.every(Number.isInteger) || majors.join(",") !== [latestMajor - 2, latestMajor - 1, latestMajor].join(",") || policy.electron.minimumSupportedMajor !== latestMajor - 2) fail("must name the contiguous latest three supported majors");
  if (!majors.includes(exact[0])) fail(`pinned major ${exact[0]} is unsupported`);
  if (!policy.provenance.some((source) => source.url === SUPPORT_URL) || !policy.provenance.some((source) => source.url === RELEASE_INDEX_URL) || !policy.provenance.some((source) => source.url === policy.electron.auditedRelease.url)) fail("is missing required official support or release provenance");
  for (const [label, value] of [["package.json", input.manifestVersion], ["installed electron package", input.installedPackageVersion], ["installed Electron runtime", input.installedRuntimeVersion]] as const) {
    versionParts(value, label);
    if (value !== policy.electron.exactVersion) fail(`${label} is ${value}; expected audited ${policy.electron.exactVersion}`);
  }
  if (audited.join(".") !== exact.join(".")) fail("installed artifact is older than the audited release");
};

/** Validates an artifact's embedded runtime, never the workspace dependency tree. */
export const validateElectronArtifactPath = async (artifactPath: string, now = new Date()) => {
  const reviewedRaw = await readFile(POLICY_PATH, "utf8");
  const policy = decodeElectronSecurityPolicy(JSON.parse(reviewedRaw));
  // Window/provenance validation deliberately receives policy values: no package
  // manager or network state is a trust input for an already-built artifact.
  validateElectronSecurityPolicy(policy, { now, manifestVersion: policy.electron.exactVersion, installedPackageVersion: policy.electron.exactVersion, installedRuntimeVersion: policy.electron.exactVersion });
  const root = path.resolve(artifactPath);
  if (!path.basename(root).endsWith(".app")) {
    const embeddedRaw = await readFile(path.join(root, "resources", "policy", "electron-security-policy.json"), "utf8");
    if (embeddedRaw !== reviewedRaw) fail(`artifact ${root} embeds a policy different from reviewed policy`);
    decodeElectronSecurityPolicy(JSON.parse(embeddedRaw));
  }
  const versionPath = path.basename(root).endsWith(".app")
    ? path.join(root, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "version")
    : path.join(root, "version");
  const version = await readVersion(versionPath);
  if (version !== policy.electron.exactVersion) fail(`artifact ${root} embeds ${version}; expected audited ${policy.electron.exactVersion}`);
  return { artifact: root, electronVersion: version, policyVersion: policy.electron.exactVersion };
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
  const policy = decodeElectronSecurityPolicy(JSON.parse(rawPolicy));
  validateElectronSecurityPolicy(policy, { now, manifestVersion: version as string, installedPackageVersion, installedRuntimeVersion });
  try {
    const receipt = JSON.parse(await readFile(observationPath(), "utf8")) as Record<string, unknown>;
    if (receipt.schemaVersion !== 1 || receipt.policyVersion !== policy.electron.exactVersion || receipt.policyHash !== policyHash(rawPolicy) || receipt.overdue !== false || receipt.disposition !== "current") fail("recorded Electron observation is stale, malformed, or mismatched");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const checkOfficialElectronSources = async (now = new Date()) => {
  const policy = decodeElectronSecurityPolicy(JSON.parse(await readFile(POLICY_PATH, "utf8")));
  const [support, releases, release] = await Promise.all([
    fetch(SUPPORT_URL), fetch(RELEASE_INDEX_URL), fetch(policy.electron.auditedRelease.url),
  ]);
  if (!support.ok || !releases.ok || !release.ok) fail(`official refresh failed: support=${support.status} releases=${releases.status} release=${release.status}`);
  const supportText = await support.text();
  if (!supportText.includes("latest 3 stable releases")) fail("official support policy no longer states latest-three support");
  const rawList = await releases.json() as unknown;
  if (!Array.isArray(rawList) || !rawList.some((entry) => isRecord(entry) && entry.version === policy.electron.auditedRelease.version)) fail(`official release index does not contain ${policy.electron.auditedRelease.version}`);
  const list = rawList as unknown[];
  const stable = list.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.test(entry.version));
  const latestByMajor = new Map<number, Record<string, unknown>>();
  for (const entry of stable) { const version = entry.version as string; const [major, minor, patch] = versionParts(version, "official release"); const prior = latestByMajor.get(major); const priorVersion = prior?.version; if (typeof priorVersion !== "string" || minor > versionParts(priorVersion, "official release")[1] || (minor === versionParts(priorVersion, "official release")[1] && patch > versionParts(priorVersion, "official release")[2])) latestByMajor.set(major, entry); }
  const supportedMajors = [...latestByMajor.keys()].sort((a, b) => b - a).slice(0, 3).sort((a, b) => a - b);
  const currentLine = latestByMajor.get(versionParts(policy.electron.exactVersion, "policy version")[0]);
  const currentLinePatch = currentLine?.version as string | undefined;
  const eol = !supportedMajors.includes(versionParts(policy.electron.exactVersion, "policy version")[0]);
  const disposition = eol ? "eol" : currentLinePatch === policy.electron.exactVersion ? "current" : "newer_patch_available";
  const observedAt = typeof currentLine?.fullDate === "string" ? date(currentLine.fullDate, "official release fullDate") : typeof currentLine?.date === "string" ? date(`${currentLine.date}T00:00:00.000Z`, "official release date") : fail("official current-line release is missing publication date");
  const dueAt = new Date(observedAt + policy.reviewSla.urgentHours * 3_600_000).toISOString();
  const overdue = eol || (disposition === "newer_patch_available" && now.getTime() >= Date.parse(dueAt));
  const receipt = { schemaVersion: 1, policyVersion: policy.electron.exactVersion, policyHash: policyHash(await readFile(POLICY_PATH, "utf8")), checkedAt: now.toISOString(), currentLinePatch, disposition, dueAt, overdue, sources: [SUPPORT_URL, RELEASE_INDEX_URL, policy.electron.auditedRelease.url] };
  const target = observationPath(); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); const temporary = `${target}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 }); await rename(temporary, target);
  return { ...receipt, supportedMajors, latestStable: latestByMajor.get(Math.max(...supportedMajors))?.version, eol };
};

/** Release-only bridge: copies, never blesses, the explicit online observation. */
export const prepareElectronObservationForPackaging = async () => {
  const raw = await readFile(observationPath(), "utf8");
  const receipt = JSON.parse(raw) as Record<string, unknown>;
  if (receipt.schemaVersion !== 1 || receipt.overdue !== false || receipt.disposition !== "current") fail("a current Electron observation receipt is required for packaging");
  await mkdir(path.dirname(packagedObservationPath), { recursive: true });
  await writeFile(packagedObservationPath, raw, { mode: 0o600 });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "validate" && process.argv.length === 3) {
    await validateCheckedInElectronPolicy();
    console.log("electron security policy: valid (offline)");
  } else if (command === "check" && process.argv.length === 3) {
    const receipt = await checkOfficialElectronSources();
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.overdue) process.exitCode = 1;
  } else if (command === "prepare-package" && process.argv.length === 3) {
    await prepareElectronObservationForPackaging();
  } else {
    console.error("usage: bun scripts/electron-security-policy.ts validate|check");
    process.exitCode = 1;
  }
}
