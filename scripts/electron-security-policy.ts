/**
 * Electron release-freshness gate. The policy is the checked-in trust root;
 * observations are a strict, locally monotonic record of an online check.
 *
 * Threat boundary: an installed signed artifact can prove the observation it
 * was packaged with, but cannot learn a later upstream release without a new
 * online observation. The owner-only high-water record prevents a previously
 * observed overdue/EOL result from being replaced by an older receipt locally.
 */
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
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
const observationDirectory = () => process.env.VELLUM_RELEASE_SECURITY_STATE_DIR ?? path.join(homedir(), ".vellum", "release-security");
const observationPath = () => path.join(observationDirectory(), "electron-observation.json");
const highWaterPath = () => path.join(observationDirectory(), "electron-observation-high-water.json");
const adversePath = (hash: string) => path.join(observationDirectory(), `electron-observation-adverse-${hash}.json`);
const packagedObservationPath = path.join(ROOT, "build", "electron-observation.json");
const packagedHighWaterPath = path.join(ROOT, "build", "electron-observation-high-water.json");
const policyHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const OBSERVATION_KEYS = ["checkedAt", "currentLinePatch", "disposition", "dueAt", "overdue", "policyHash", "policyVersion", "schemaVersion", "sources", "stablePublishedAt"] as const;

export interface ElectronSecurityPolicy {
  readonly schemaVersion: 1;
  readonly reviewedAt: string;
  readonly expiresAt: string;
  readonly reviewSla: { readonly routineDays: number; readonly urgentHours: number };
  readonly electron: { readonly exactVersion: string; readonly minimumSupportedMajor: number; readonly currentSupportedMajors: readonly number[]; readonly auditedRelease: { readonly version: string; readonly publishedAt: string; readonly url: string } };
  readonly provenance: readonly { readonly url: string; readonly purpose: string }[];
}
export interface ElectronObservation {
  readonly schemaVersion: 2;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly checkedAt: string;
  readonly currentLinePatch: string;
  readonly stablePublishedAt: string;
  readonly disposition: "current" | "newer_patch_available" | "eol";
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly sources: readonly [string, string, string];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(`electron security policy: ${message}`); };
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} keys must be exactly ${expected.join(", ")}`);
};
const versionParts = (version: string, label: string) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`${label} must be a canonical x.y.z version`);
  return match!.slice(1).map(Number) as [number, number, number];
};
const compareVersions = (left: string, right: string) => {
  const a = versionParts(left, "version"); const b = versionParts(right, "version");
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};
const date = (value: string, label: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`${label} must be canonical ISO-8601 UTC`);
  return parsed;
};
const officialUrl = (value: string, label: string) => {
  let parsed: URL; try { parsed = new URL(value); } catch { return fail(`${label} must be an absolute URL`); }
  if (parsed.protocol !== "https:" || (parsed.hostname !== "www.electronjs.org" && parsed.hostname !== "releases.electronjs.org")) fail(`${label} must be an official Electron HTTPS URL`);
};

export const decodeElectronSecurityPolicy = (input: unknown): ElectronSecurityPolicy => {
  if (!isRecord(input)) fail("must be an object"); const policy = input as Record<string, unknown>;
  exactKeys(policy, ["electron", "expiresAt", "provenance", "reviewSla", "reviewedAt", "schemaVersion"], "policy");
  if (policy.schemaVersion !== 1 || typeof policy.reviewedAt !== "string" || typeof policy.expiresAt !== "string" || !isRecord(policy.reviewSla) || !isRecord(policy.electron) || !Array.isArray(policy.provenance)) fail("has an invalid shape");
  const reviewSla = policy.reviewSla as Record<string, unknown>; exactKeys(reviewSla, ["routineDays", "urgentHours"], "reviewSla");
  if (!Number.isInteger(reviewSla.routineDays) || (reviewSla.routineDays as number) <= 0 || !Number.isInteger(reviewSla.urgentHours) || (reviewSla.urgentHours as number) <= 0) fail("review SLAs must be positive integers");
  const electron = policy.electron as Record<string, unknown>; exactKeys(electron, ["auditedRelease", "currentSupportedMajors", "exactVersion", "minimumSupportedMajor"], "electron");
  if (typeof electron.exactVersion !== "string" || !Number.isInteger(electron.minimumSupportedMajor) || !Array.isArray(electron.currentSupportedMajors) || !isRecord(electron.auditedRelease)) fail("electron has an invalid shape");
  const auditedRelease = electron.auditedRelease as Record<string, unknown>; exactKeys(auditedRelease, ["publishedAt", "url", "version"], "auditedRelease");
  if (typeof auditedRelease.version !== "string" || typeof auditedRelease.publishedAt !== "string" || typeof auditedRelease.url !== "string") fail("auditedRelease has an invalid shape");
  const sources = policy.provenance as unknown[]; if (sources.length !== 3 || !sources.every(isRecord)) fail("must retain exactly three official provenance records");
  const provenance = (sources as Record<string, unknown>[]).map((source) => { exactKeys(source, ["purpose", "url"], "provenance source"); if (typeof source.url !== "string" || typeof source.purpose !== "string" || source.purpose.length === 0) fail("provenance source has an invalid shape"); officialUrl(source.url as string, "provenance URL"); return { url: source.url as string, purpose: source.purpose as string }; });
  return { schemaVersion: 1, reviewedAt: policy.reviewedAt as string, expiresAt: policy.expiresAt as string, reviewSla: { routineDays: reviewSla.routineDays as number, urgentHours: reviewSla.urgentHours as number }, electron: { exactVersion: electron.exactVersion as string, minimumSupportedMajor: electron.minimumSupportedMajor as number, currentSupportedMajors: electron.currentSupportedMajors as number[], auditedRelease: { version: auditedRelease.version as string, publishedAt: auditedRelease.publishedAt as string, url: auditedRelease.url as string } }, provenance };
};

export const validateElectronSecurityPolicy = (policy: ElectronSecurityPolicy, input: { readonly now: Date; readonly manifestVersion: string; readonly installedPackageVersion: string; readonly installedRuntimeVersion: string }) => {
  const reviewedAt = date(policy.reviewedAt, "reviewedAt"); const expiresAt = date(policy.expiresAt, "expiresAt");
  if (reviewedAt > input.now.getTime()) fail(`reviewedAt ${policy.reviewedAt} is in the future`);
  if (expiresAt <= reviewedAt || expiresAt > reviewedAt + policy.reviewSla.routineDays * 86_400_000 || input.now.getTime() >= expiresAt) fail(`expired at ${policy.expiresAt}`);
  const exact = versionParts(policy.electron.exactVersion, "electron.exactVersion"); const audited = versionParts(policy.electron.auditedRelease.version, "auditedRelease.version");
  if (date(policy.electron.auditedRelease.publishedAt, "auditedRelease.publishedAt") > reviewedAt) fail("audited release was published after the policy review");
  officialUrl(policy.electron.auditedRelease.url, "auditedRelease.url");
  if (policy.electron.exactVersion !== policy.electron.auditedRelease.version) fail("exactVersion must equal auditedRelease.version");
  const majors = policy.electron.currentSupportedMajors; const latestMajor = Math.max(...majors);
  if (majors.length !== 3 || new Set(majors).size !== majors.length || !majors.every(Number.isInteger) || majors.join(",") !== [latestMajor - 2, latestMajor - 1, latestMajor].join(",") || policy.electron.minimumSupportedMajor !== latestMajor - 2) fail("must name the contiguous latest three supported majors");
  if (!majors.includes(exact[0])) fail(`pinned major ${exact[0]} is unsupported`);
  if (policy.provenance.map((source) => source.url).join("\n") !== [SUPPORT_URL, RELEASE_INDEX_URL, policy.electron.auditedRelease.url].join("\n")) fail("is missing required official bounded provenance");
  for (const [label, value] of [["package.json", input.manifestVersion], ["installed electron package", input.installedPackageVersion], ["installed Electron runtime", input.installedRuntimeVersion]] as const) { versionParts(value, label); if (value !== policy.electron.exactVersion) fail(`${label} is ${value}; expected audited ${policy.electron.exactVersion}`); }
  if (audited.join(".") !== exact.join(".")) fail("installed artifact is older than the audited release");
};

export const decodeElectronObservation = (input: unknown): ElectronObservation => {
  if (!isRecord(input)) fail("observation must be an object"); const record = input as Record<string, unknown>; exactKeys(record, OBSERVATION_KEYS, "observation");
  if (record.schemaVersion !== 2 || typeof record.policyVersion !== "string" || typeof record.policyHash !== "string" || !/^[a-f0-9]{64}$/.test(record.policyHash) || typeof record.checkedAt !== "string" || typeof record.currentLinePatch !== "string" || typeof record.stablePublishedAt !== "string" || typeof record.dueAt !== "string" || typeof record.overdue !== "boolean" || !Array.isArray(record.sources) || record.sources.length !== 3 || !record.sources.every((source) => typeof source === "string") || (record.disposition !== "current" && record.disposition !== "newer_patch_available" && record.disposition !== "eol")) fail("observation has an invalid shape");
  return { schemaVersion: 2, policyVersion: record.policyVersion as string, policyHash: record.policyHash as string, checkedAt: record.checkedAt as string, currentLinePatch: record.currentLinePatch as string, stablePublishedAt: record.stablePublishedAt as string, dueAt: record.dueAt as string, overdue: record.overdue as boolean, disposition: record.disposition as ElectronObservation["disposition"], sources: record.sources as [string, string, string] };
};

export const validateElectronObservation = (observation: ElectronObservation, policy: ElectronSecurityPolicy, rawPolicy: string, now: Date) => {
  if (observation.policyVersion !== policy.electron.exactVersion || observation.policyHash !== policyHash(rawPolicy)) fail("observation policy version or hash mismatches reviewed policy");
  const checkedAt = date(observation.checkedAt, "observation.checkedAt"); const publishedAt = date(observation.stablePublishedAt, "observation.stablePublishedAt"); const dueAt = date(observation.dueAt, "observation.dueAt");
  if (checkedAt < publishedAt || dueAt !== publishedAt + policy.reviewSla.urgentHours * 3_600_000) fail("observation publication and dueAt semantics are invalid");
  const current = versionParts(observation.currentLinePatch, "observation.currentLinePatch"); const exact = versionParts(policy.electron.exactVersion, "policy version");
  if (current[0] !== exact[0]) fail("observation current-line patch must be in the pinned major");
  const expectedSources = [SUPPORT_URL, RELEASE_INDEX_URL, policy.electron.auditedRelease.url];
  if (observation.sources.join("\n") !== expectedSources.join("\n")) fail("observation sources must be the exact bounded official source IDs");
  const expectedOverdue = observation.disposition === "eol" || (observation.disposition === "newer_patch_available" && now.getTime() >= dueAt);
  if (observation.disposition === "current" && observation.currentLinePatch !== policy.electron.exactVersion) fail("current observation must equal the pinned version");
  if (observation.disposition === "newer_patch_available" && compareVersions(observation.currentLinePatch, policy.electron.exactVersion) <= 0) fail("newer patch observation must exceed the pinned version");
  if (observation.disposition === "eol" && !observation.overdue) fail("EOL observation must be overdue");
  if (observation.overdue !== expectedOverdue) fail("observation overdue disposition is inconsistent with dueAt");
};
/** The one consumer gate: structurally valid risk evidence is never admission. */
export const requireElectronObservationAdmission = (observation: ElectronObservation) => {
  if (observation.disposition === "eol" || observation.overdue) fail("Electron observation is adverse and cannot admit consumers");
};

const readVersion = async (filename: string, field?: string): Promise<string> => { const raw = await readFile(filename, "utf8"); if (!field) return raw.trim(); const parsed = JSON.parse(raw) as Record<string, unknown>; if (typeof parsed[field] !== "string") fail(`${filename} is missing ${field}`); return parsed[field] as string; };
const readObservation = async (filename: string) => decodeElectronObservation(JSON.parse(await readFile(filename, "utf8")));
const sameObservation = (left: ElectronObservation, right: ElectronObservation) => JSON.stringify(left) === JSON.stringify(right);

const requirePrivateStateDirectory = async (directory: string) => {
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); } catch (error) { throw error; }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) fail("observation state directory must be an owner-owned non-symlink private directory");
};
const atomicPrivateWrite = async (target: string, content: string) => {
  const directory = path.dirname(target); await requirePrivateStateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, target); await (await open(directory, constants.O_RDONLY)).sync();
    const result = await lstat(target); if (!result.isFile() || result.isSymbolicLink() || (result.mode & 0o777) !== 0o600) fail("observation receipt must be a regular 0600 file");
  } catch (error) { await handle?.close(); await unlink(temporary).catch(() => undefined); throw error; }
};
const writePrivateNoOverwrite = async (target: string, content: string) => {
  const directory = path.dirname(target); await requirePrivateStateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = undefined;
    await link(temporary, target); await unlink(temporary); await (await open(directory, constants.O_RDONLY)).sync();
    const result = await lstat(target); if (!result.isFile() || result.isSymbolicLink() || (result.mode & 0o777) !== 0o600) fail("adverse observation marker must be a regular 0600 file");
  } catch (error) { await handle?.close(); await unlink(temporary).catch(() => undefined); throw error; }
};
const withStateLock = async <T>(directory: string, operation: () => Promise<T>): Promise<T> => {
  await requirePrivateStateDirectory(directory); const lock = path.join(directory, ".electron-observation.lock");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { return await operation(); } finally { await handle.close(); await unlink(lock).catch(() => undefined); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  return fail("observation state lock did not become available");
};
const persistObservation = async (receipt: ElectronObservation) => withStateLock(observationDirectory(), async () => {
  const water = highWaterPath();
  const marker = adversePath(receipt.policyHash);
  try {
    const adverse = await readObservation(marker);
    if (adverse.disposition === "eol" || adverse.overdue) {
      if (receipt.disposition === "eol" || receipt.overdue) return;
      fail("adverse observation is irreversible for this policy epoch");
    }
    fail("adverse observation marker is malformed");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { const existing = await readObservation(water); if (Date.parse(existing.checkedAt) > Date.parse(receipt.checkedAt)) fail("older observation cannot replace newer known state"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const content = `${JSON.stringify(receipt)}\n`;
  if (receipt.disposition === "eol" || receipt.overdue) await writePrivateNoOverwrite(marker, content);
  await atomicPrivateWrite(water, content); await atomicPrivateWrite(observationPath(), content);
});
const readAdverseMarker = async (policy: ElectronSecurityPolicy, rawPolicy: string, now: Date) => {
  try { const marker = await readObservation(adversePath(policyHash(rawPolicy))); validateElectronObservation(marker, policy, rawPolicy, now); if (marker.disposition !== "eol" && !marker.overdue) fail("adverse observation marker is not adverse"); return marker; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
const validatePersistedObservation = async (policy: ElectronSecurityPolicy, rawPolicy: string, now: Date, required: boolean) => {
  const adverse = await readAdverseMarker(policy, rawPolicy, now);
  try { const [receipt, water] = await Promise.all([readObservation(observationPath()), readObservation(highWaterPath())]); validateElectronObservation(receipt, policy, rawPolicy, now); validateElectronObservation(water, policy, rawPolicy, now); if (!sameObservation(receipt, water)) fail("recorded Electron observation is not the current high-water state"); if (adverse) fail("adverse observation survives this mutable receipt pair"); requireElectronObservationAdmission(receipt); return receipt; }
  catch (error) { if (!required && !adverse && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

export const validateCheckedInElectronPolicy = async (now = new Date()) => {
  const [rawPolicy, installedPackageVersion, installedRuntimeVersion] = await Promise.all([readFile(POLICY_PATH, "utf8"), readVersion(INSTALLED_PACKAGE_PATH, "version"), readVersion(INSTALLED_RUNTIME_PATH)]);
  const manifest = JSON.parse(await readFile(PACKAGE_PATH, "utf8")) as { devDependencies?: Record<string, unknown> }; const version = manifest.devDependencies?.electron;
  if (typeof version !== "string") fail("package.json is missing devDependencies.electron"); const policy = decodeElectronSecurityPolicy(JSON.parse(rawPolicy));
  validateElectronSecurityPolicy(policy, { now, manifestVersion: version as string, installedPackageVersion, installedRuntimeVersion }); await validatePersistedObservation(policy, rawPolicy, now, false);
};

export const validateElectronArtifactPath = async (artifactPath: string, now = new Date()) => {
  const reviewedRaw = await readFile(POLICY_PATH, "utf8"); const policy = decodeElectronSecurityPolicy(JSON.parse(reviewedRaw));
  validateElectronSecurityPolicy(policy, { now, manifestVersion: policy.electron.exactVersion, installedPackageVersion: policy.electron.exactVersion, installedRuntimeVersion: policy.electron.exactVersion });
  const root = path.resolve(artifactPath); const resources = path.basename(root).endsWith(".app") ? path.join(root, "Contents", "Resources") : path.join(root, "resources");
  const embeddedRaw = await readFile(path.join(resources, "policy", "electron-security-policy.json"), "utf8"); if (embeddedRaw !== reviewedRaw) fail(`artifact ${root} embeds a policy different from reviewed policy`);
  const receipt = await readObservation(path.join(resources, "policy", "electron-observation.json")); const water = await readObservation(path.join(resources, "policy", "electron-observation-high-water.json"));
  validateElectronObservation(receipt, policy, embeddedRaw, now); validateElectronObservation(water, policy, embeddedRaw, now); if (!sameObservation(receipt, water)) fail("artifact observation is not its current high-water state"); requireElectronObservationAdmission(receipt);
  const local = await validatePersistedObservation(policy, reviewedRaw, now, false);
  if (local && !sameObservation(receipt, local)) fail("artifact observation differs from latest private state");
  const versionPath = path.basename(root).endsWith(".app") ? path.join(root, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "version") : path.join(root, "version"); const version = await readVersion(versionPath);
  if (version !== policy.electron.exactVersion) fail(`artifact ${root} embeds ${version}; expected audited ${policy.electron.exactVersion}`); return { artifact: root, electronVersion: version, policyVersion: policy.electron.exactVersion };
};

export const checkOfficialElectronSources = async (now = new Date()) => {
  const rawPolicy = await readFile(POLICY_PATH, "utf8"); const policy = decodeElectronSecurityPolicy(JSON.parse(rawPolicy));
  const [support, releases, release] = await Promise.all([fetch(SUPPORT_URL), fetch(RELEASE_INDEX_URL), fetch(policy.electron.auditedRelease.url)]);
  if (!support.ok || !releases.ok || !release.ok) fail(`official refresh failed: support=${support.status} releases=${releases.status} release=${release.status}`);
  if (!(await support.text()).includes("latest 3 stable releases")) fail("official support policy no longer states latest-three support"); const rawList = await releases.json() as unknown;
  if (!Array.isArray(rawList) || !rawList.some((entry) => isRecord(entry) && entry.version === policy.electron.auditedRelease.version)) fail(`official release index does not contain ${policy.electron.auditedRelease.version}`);
  const latestByMajor = new Map<number, Record<string, unknown>>();
  for (const entry of rawList as unknown[]) if (isRecord(entry) && typeof entry.version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.test(entry.version)) { const [major] = versionParts(entry.version, "official release"); const prior = latestByMajor.get(major); if (!prior || compareVersions(entry.version, prior.version as string) > 0) latestByMajor.set(major, entry); }
  const supportedMajors = [...latestByMajor.keys()].sort((a, b) => b - a).slice(0, 3).sort((a, b) => a - b); const exactMajor = versionParts(policy.electron.exactVersion, "policy version")[0]; const currentLine = latestByMajor.get(exactMajor);
  if (!currentLine || typeof currentLine.version !== "string") return fail("official current-line release is missing"); const current = currentLine as Record<string, unknown>; const currentLinePatch = current.version as string;
  const stablePublishedAt = typeof current.fullDate === "string" ? current.fullDate : typeof current.date === "string" ? `${current.date}T00:00:00.000Z` : fail("official current-line release is missing publication date");
  date(stablePublishedAt, "official release publication date"); const eol = !supportedMajors.includes(exactMajor); const disposition = eol ? "eol" : currentLinePatch === policy.electron.exactVersion ? "current" : "newer_patch_available"; const dueAt = new Date(Date.parse(stablePublishedAt) + policy.reviewSla.urgentHours * 3_600_000).toISOString();
  const receipt: ElectronObservation = { schemaVersion: 2, policyVersion: policy.electron.exactVersion, policyHash: policyHash(rawPolicy), checkedAt: now.toISOString(), currentLinePatch, stablePublishedAt, disposition, dueAt, overdue: eol || (disposition === "newer_patch_available" && now.getTime() >= Date.parse(dueAt)), sources: [SUPPORT_URL, RELEASE_INDEX_URL, policy.electron.auditedRelease.url] };
  validateElectronObservation(receipt, policy, rawPolicy, now); await persistObservation(receipt); return { ...receipt, supportedMajors, latestStable: latestByMajor.get(Math.max(...supportedMajors))?.version as string | undefined, eol };
};

/** Release-only bridge: copies an already validated current high-water pair. */
export const prepareElectronObservationForPackaging = async (now = new Date()) => {
  const rawPolicy = await readFile(POLICY_PATH, "utf8"); const policy = decodeElectronSecurityPolicy(JSON.parse(rawPolicy)); const receipt = await validatePersistedObservation(policy, rawPolicy, now, true);
  if (!receipt || receipt.disposition !== "current" || receipt.overdue) fail("a current Electron observation receipt is required for packaging");
  await mkdir(path.dirname(packagedObservationPath), { recursive: true }); const content = `${JSON.stringify(receipt)}\n`; await writeFile(packagedObservationPath, content, { mode: 0o600 }); await writeFile(packagedHighWaterPath, content, { mode: 0o600 });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) { const command = process.argv[2]; if (command === "validate" && process.argv.length === 3) { await validateCheckedInElectronPolicy(); console.log("electron security policy: valid (offline)"); } else if (command === "check" && process.argv.length === 3) { const receipt = await checkOfficialElectronSources(); console.log(JSON.stringify(receipt, null, 2)); if (receipt.overdue) process.exitCode = 1; } else if (command === "prepare-package" && process.argv.length === 3) await prepareElectronObservationForPackaging(); else { console.error("usage: bun scripts/electron-security-policy.ts validate|check|prepare-package"); process.exitCode = 1; } }
