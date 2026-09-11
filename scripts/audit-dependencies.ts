#!/usr/bin/env bun
/**
 * Risk-based bun audit gate.
 *
 * Full `bun audit --json` is the source. Classification uses the lockfile graph
 * and enabled packaging targets, not package names or `bun audit --prod`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCEPTIONS_PATH = resolve(ROOT, "scripts/dependency-audit-exceptions.json");
const MUST_CLEAR = new Set(["tar", "js-yaml"]);
const HIGH = new Set(["high", "critical"]);
const PACKAGING_ROOTS = new Set([
  "electron-builder",
  "app-builder-lib",
  "dmg-builder",
  "@electron/osx-sign",
  "@electron/asar",
  "@electron/fuses",
  "electron-updater",
]);
const RUNTIME_ROOTS = new Set(["tar", "electron-updater", "js-yaml", "effect", "@effect/platform-node", "@effect/platform-bun"]);

export type Advisory = {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly severity: string;
  readonly vulnerable_versions: string;
};

export type AuditJson = Record<string, Advisory[]>;

export type Exception = {
  readonly package: string;
  readonly ghsa: string;
  readonly versions: readonly string[];
  readonly lockfilePaths: readonly string[];
  readonly scope: "runtime" | "packaging" | "development";
  readonly reason: string;
  readonly owner: string;
  readonly expires: string;
  readonly tracking: string;
};

export type ExceptionsFile = {
  readonly schema: 1;
  readonly exceptions: readonly Exception[];
};

export type Finding = {
  readonly package: string;
  readonly ghsa: string;
  readonly severity: string;
  readonly title: string;
  readonly vulnerableVersions: string;
  readonly scope: "runtime" | "packaging" | "development";
};

const ghsaOf = (url: string): string => {
  const match = /GHSA-[a-z0-9-]+/u.exec(url);
  if (match === null) throw new Error(`advisory URL is missing a GHSA id: ${url}`);
  return match[0];
};

export const parseAuditJson = (raw: string): AuditJson => {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bun audit JSON must be an object keyed by package name");
  }
  const out: Record<string, Advisory[]> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) throw new Error(`bun audit JSON for ${name} is not an array`);
    out[name] = value.map((item) => {
      if (item === null || typeof item !== "object") throw new Error(`malformed advisory in ${name}`);
      const advisory = item as Record<string, unknown>;
      if (typeof advisory.id !== "number" || typeof advisory.url !== "string" || typeof advisory.title !== "string") {
        throw new Error(`malformed advisory fields in ${name}`);
      }
      if (typeof advisory.severity !== "string" || typeof advisory.vulnerable_versions !== "string") {
        throw new Error(`malformed advisory severity in ${name}`);
      }
      return {
        id: advisory.id,
        url: advisory.url,
        title: advisory.title,
        severity: advisory.severity,
        vulnerable_versions: advisory.vulnerable_versions,
      };
    });
  }
  return out;
};

export const loadExceptions = (raw: string): ExceptionsFile => {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("exceptions file must be an object");
  }
  const file = parsed as Record<string, unknown>;
  if (file.schema !== 1 || !Array.isArray(file.exceptions)) throw new Error("exceptions schema must be 1");
  const exceptions = file.exceptions.map((item) => {
    if (item === null || typeof item !== "object") throw new Error("malformed exception");
    const exception = item as Record<string, unknown>;
    if (
      typeof exception.package !== "string" ||
      typeof exception.ghsa !== "string" ||
      !Array.isArray(exception.versions) ||
      !Array.isArray(exception.lockfilePaths) ||
      (exception.scope !== "runtime" && exception.scope !== "packaging" && exception.scope !== "development") ||
      typeof exception.reason !== "string" ||
      typeof exception.owner !== "string" ||
      typeof exception.expires !== "string" ||
      typeof exception.tracking !== "string"
    ) {
      throw new Error("malformed exception fields");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(exception.expires)) throw new Error(`invalid exception expiry: ${exception.expires}`);
    return exception as Exception;
  });
  return { schema: 1, exceptions };
};

export const parseEnabledLinuxTargets = (packageJson: string): readonly string[] => {
  const parsed: unknown = JSON.parse(packageJson);
  if (parsed === null || typeof parsed !== "object") throw new Error("package.json must be an object");
  const linux = (parsed as { build?: { linux?: { target?: unknown } } }).build?.linux?.target;
  if (!Array.isArray(linux)) throw new Error("package.json build.linux.target must be an array");
  return linux.map((item) => {
    if (typeof item === "string") return item;
    if (item !== null && typeof item === "object" && typeof (item as { target?: unknown }).target === "string") {
      return (item as { target: string }).target;
    }
    throw new Error("linux target entries must be strings");
  });
};

const cmp = (left: string, right: string): number => {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
};

export const satisfiesVulnerable = (version: string, range: string): boolean => {
  const clauses = range.split("||").map((clause) => clause.trim()).filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;
  return clauses.some((clause) =>
    clause.split(/\s+/u).every((token) => {
      const match = /^(<=|<|>=|>|=)?(.+)$/u.exec(token);
      if (match === null) return false;
      const op = match[1] ?? "=";
      const bound = match[2]!;
      const order = cmp(version, bound);
      if (op === "<") return order < 0;
      if (op === "<=") return order <= 0;
      if (op === ">") return order > 0;
      if (op === ">=") return order >= 0;
      return order === 0;
    }),
  );
};

type LockEntry = { readonly name: string; readonly version: string; readonly parents: readonly string[] };

export const parseLockPackages = (lockText: string): readonly LockEntry[] => {
  const entries: LockEntry[] = [];
  const pattern = /"([^"]+)": \["([^@"]+)@([^"]+)"/g;
  for (const match of lockText.matchAll(pattern)) {
    const key = match[1]!;
    const name = match[2]!;
    const version = match[3]!;
    if (!key.endsWith(name)) continue;
    const prefix = key.slice(0, Math.max(0, key.length - name.length));
    const parents = prefix === "" ? [] : prefix.replace(/\/$/u, "").split("/").filter((piece) => piece.length > 0);
    entries.push({ name, version, parents });
  }
  return entries;
};

export const classifyScope = (entry: LockEntry, _linuxTargets: readonly string[]): "runtime" | "packaging" | "development" => {
  if (entry.name === "tar" && entry.parents.length === 0) return "runtime";
  if (RUNTIME_ROOTS.has(entry.name) && entry.parents.length === 0) return "runtime";
  if (entry.parents.includes("electron-updater") || entry.parents[0] === "electron-updater") return "runtime";
  if (PACKAGING_ROOTS.has(entry.name) || entry.parents.some((parent) => PACKAGING_ROOTS.has(parent))) return "packaging";
  return "development";
};

const lockfilePathOf = (entry: LockEntry): string =>
  entry.parents.length === 0 ? entry.name : `${entry.parents.join("/")}/${entry.name}`;

export const collectFindings = (input: {
  readonly audit: AuditJson;
  readonly lock: readonly LockEntry[];
  readonly linuxTargets: readonly string[];
}): readonly Finding[] => {
  const findings: Finding[] = [];
  for (const [name, advisories] of Object.entries(input.audit)) {
    const copies = input.lock.filter((entry) => entry.name === name);
    for (const advisory of advisories) {
      const ghsa = ghsaOf(advisory.url);
      const matching = copies.filter((entry) => satisfiesVulnerable(entry.version, advisory.vulnerable_versions));
      if (matching.length === 0) continue;
      const scopes = new Set(matching.map((entry) => classifyScope(entry, input.linuxTargets)));
      const scope = scopes.has("runtime") ? "runtime" : scopes.has("packaging") ? "packaging" : "development";
      findings.push({
        package: name,
        ghsa,
        severity: advisory.severity,
        title: advisory.title,
        vulnerableVersions: advisory.vulnerable_versions,
        scope,
      });
    }
  }
  return findings;
};

const todayUtc = (now: Date): string => now.toISOString().slice(0, 10);

export const exceptionCovers = (
  exception: Exception,
  finding: Finding,
  now: Date,
  lock: readonly LockEntry[],
): boolean => {
  if (exception.package !== finding.package || exception.ghsa !== finding.ghsa) return false;
  if (exception.scope !== finding.scope) return false;
  if (exception.expires < todayUtc(now)) return false;
  const copies = lock.filter((entry) => entry.name === finding.package);
  const matching = copies.filter((entry) => exception.lockfilePaths.includes(lockfilePathOf(entry)));
  if (matching.length === 0) return false;
  return matching.every((entry) => exception.versions.includes(entry.version));
};

export const blockedFindings = (input: {
  readonly findings: readonly Finding[];
  readonly exceptions: readonly Exception[];
  readonly linuxTargets: readonly string[];
  readonly lock: readonly LockEntry[];
  readonly now?: Date;
}): readonly Finding[] => {
  const now = input.now ?? new Date();
  return input.findings.filter((finding) => {
    if (MUST_CLEAR.has(finding.package)) return true;
    if (!HIGH.has(finding.severity)) return false;
    if (finding.ghsa === "GHSA-7g7r-gx96-252g" && !input.linuxTargets.includes("AppImage")) return false;
    return !input.exceptions.some((exception) => exceptionCovers(exception, finding, now, input.lock));
  });
};

export const summarize = (audit: AuditJson, findings: readonly Finding[]) => {
  const rows = Object.values(audit).reduce((sum, items) => sum + items.length, 0);
  const unique = new Set(findings.map((finding) => finding.ghsa));
  const uniqueRows = new Set(
    Object.values(audit).flatMap((items) => items.map((item) => ghsaOf(item.url))),
  );
  return { advisoryRows: rows, uniqueGhsas: uniqueRows.size, blockedGhsas: unique.size };
};

export const runBunAudit = (cwd = ROOT): { readonly stdout: string; readonly stderr: string; readonly status: number } => {
  const result = spawnSync("bun", ["audit", "--json"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
};

const isDirect = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  try {
    const auditRun = runBunAudit();
    const raw = auditRun.stdout.trim();
    if (raw.length === 0) {
      throw new Error(`bun audit produced no JSON (exit ${auditRun.status}): ${auditRun.stderr}`);
    }
    const audit = parseAuditJson(raw);
    const exceptions = loadExceptions(readFileSync(EXCEPTIONS_PATH, "utf8"));
    const linuxTargets = parseEnabledLinuxTargets(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const lock = parseLockPackages(readFileSync(resolve(ROOT, "bun.lock"), "utf8"));
    const findings = collectFindings({ audit, lock, linuxTargets });
    const blocked = blockedFindings({ findings, exceptions: exceptions.exceptions, linuxTargets, lock });
    const summary = summarize(audit, findings);
    process.stdout.write(
      `${JSON.stringify({ ...summary, findings: findings.length, blocked: blocked.length, linuxTargets }, null, 2)}\n`,
    );
    if (blocked.length > 0) {
      for (const finding of blocked) {
        process.stderr.write(`${finding.severity} ${finding.package} ${finding.ghsa} (${finding.scope}) ${finding.title}\n`);
      }
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`vellum-command: error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
