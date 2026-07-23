/**
 * Shared HMAC document-seal primitives.
 *
 * App-owned integrity for topology-like durable files (station settings,
 * hosts registry, …). Not a crypto vault — same-UID wipe of key+seal can
 * re-bootstrap. Ordinary offline edit of the plaintext alone cannot mint.
 *
 * Domain separation: each consumer passes a fixed domainTag into macForBody.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SEAL_KEY_BYTES = 32;
export const SEAL_ALG = "hmac-sha256" as const;

export type SealPaths = {
  readonly key: string;
  readonly seal: string;
  readonly dir: string;
};

export type SealDocument = {
  readonly version: number;
  readonly alg: string;
  readonly mac: string;
};

export type SealVerifyStatus =
  | { readonly status: "valid" }
  | { readonly status: "bootstrap"; readonly reason: "no-key-no-seal" }
  | {
      readonly status: "reject";
      readonly reason:
        | "mac-mismatch"
        | "seal-missing"
        | "key-missing"
        | "corrupt-seal";
    };

export const sealPathsBeside = (
  documentPath: string,
  keyBasename: string,
  sealBasename: string,
): SealPaths => {
  const dir = dirname(documentPath);
  return {
    dir,
    key: join(dir, keyBasename),
    seal: join(dir, sealBasename),
  };
};

export const fileExistsAsRegular = async (path: string): Promise<boolean> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      return info.isFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Symlink / not-a-file / ELOOP → treat as present-but-unusable (reject path).
    return true;
  }
};

export const readSealKey = async (keyPath: string): Promise<Buffer | null> => {
  try {
    const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < SEAL_KEY_BYTES || info.size > 64) {
        return null;
      }
      const raw = await handle.readFile();
      if (raw.byteLength < SEAL_KEY_BYTES) return null;
      return Buffer.from(raw.subarray(0, SEAL_KEY_BYTES));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

export const readSealDocument = async (
  sealPath: string,
): Promise<SealDocument | null> => {
  try {
    const handle = await open(sealPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4_096) return null;
      const raw = await handle.readFile("utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.version !== "number" ||
        typeof record.alg !== "string" ||
        typeof record.mac !== "string"
      ) {
        return null;
      }
      return {
        version: record.version,
        alg: record.alg,
        mac: record.mac,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

export const atomicWriteBytes = async (
  path: string,
  body: Buffer | string,
  mode: number,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  if (typeof body === "string") {
    await writeFile(tmp, body, { encoding: "utf8", flag: "wx", mode });
  } else {
    await writeFile(tmp, body, { flag: "wx", mode });
  }
  await rename(tmp, path);
};

/** Ensure a machine-local key exists at keyPath; return it. */
export const ensureSealKey = async (keyPath: string): Promise<Buffer> => {
  const existing = await readSealKey(keyPath);
  if (existing) return existing;
  const next = randomBytes(SEAL_KEY_BYTES);
  await atomicWriteBytes(keyPath, next, 0o600);
  return next;
};

export const macForBody = (
  key: Buffer,
  domainTag: string,
  body: Buffer,
): Buffer => {
  const hmac = createHmac("sha256", key);
  hmac.update(domainTag);
  hmac.update(body);
  return hmac.digest();
};

export const safeEqualMac = (left: Buffer, right: Buffer): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
};

/** Write (or overwrite) the seal file for the given canonical body. */
export const writeSealFile = async (
  paths: SealPaths,
  domainTag: string,
  version: number,
  alg: typeof SEAL_ALG,
  body: Buffer,
): Promise<void> => {
  const key = await ensureSealKey(paths.key);
  const mac = macForBody(key, domainTag, body).toString("base64url");
  const doc = { version, alg, mac };
  await atomicWriteBytes(paths.seal, `${JSON.stringify(doc)}\n`, 0o600);
};

/**
 * Admit rules:
 * - key+seal absent → bootstrap
 * - key/seal asymmetric, corrupt, or MAC mismatch → reject
 * - both present + MAC ok → valid
 */
export const verifySealFile = async (
  paths: SealPaths,
  domainTag: string,
  version: number,
  alg: typeof SEAL_ALG,
  body: Buffer,
): Promise<SealVerifyStatus> => {
  const keyPresent = await fileExistsAsRegular(paths.key);
  const sealPresent = await fileExistsAsRegular(paths.seal);

  if (!keyPresent && !sealPresent) {
    return { status: "bootstrap", reason: "no-key-no-seal" };
  }
  if (keyPresent && !sealPresent) {
    return { status: "reject", reason: "seal-missing" };
  }
  if (!keyPresent && sealPresent) {
    return { status: "reject", reason: "key-missing" };
  }

  const key = await readSealKey(paths.key);
  const seal = await readSealDocument(paths.seal);
  if (!key || !seal) {
    return { status: "reject", reason: "corrupt-seal" };
  }
  if (seal.version !== version || seal.alg !== alg) {
    return { status: "reject", reason: "corrupt-seal" };
  }

  let claimed: Buffer;
  try {
    claimed = Buffer.from(seal.mac, "base64url");
  } catch {
    return { status: "reject", reason: "corrupt-seal" };
  }
  if (claimed.byteLength === 0) {
    return { status: "reject", reason: "corrupt-seal" };
  }

  const expected = macForBody(key, domainTag, body);
  if (!safeEqualMac(expected, claimed)) {
    return { status: "reject", reason: "mac-mismatch" };
  }
  return { status: "valid" };
};

/** Pure helper for tests: compute MAC for a known key. */
export const debugMacForBody = (
  key: Buffer,
  domainTag: string,
  body: Buffer,
): string => macForBody(key, domainTag, body).toString("base64url");
