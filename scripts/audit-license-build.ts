import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, statFile } from "@electron/asar";
import {
  resolveLicenseBuildProfile,
  type ReleaseLicenseBuildProfile,
} from "./license-build-profile";

export const PACKAGED_LICENSE_MAIN_ENTRY = "out/main/index.js" as const;
const MAX_LICENSE_MAIN_BYTES = 8 * 1024 * 1024;

export interface LicenseBuildAuditReceipt
  extends ReleaseLicenseBuildProfile {
  readonly entry: typeof PACKAGED_LICENSE_MAIN_ENTRY;
  readonly bytes: number;
}

const exactlyOneMatch = (
  source: string,
  pattern: RegExp,
  label: string,
): string => {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(
      `compiled license binding requires exactly one ${label}, got ${matches.length}`,
    );
  }
  return matches[0][1];
};

export const auditCompiledLicenseMain = (
  bytes: Uint8Array,
  expected?: ReleaseLicenseBuildProfile,
): LicenseBuildAuditReceipt => {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_LICENSE_MAIN_BYTES) {
    throw new Error(
      `compiled license main is outside its byte bound: ${bytes.byteLength}`,
    );
  }
  const source = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("utf8");
  const start = source.indexOf("const compiledChannel =");
  const end = source.indexOf("const DODO_LICENSE_BASE_URLS", start);
  if (
    start < 0 ||
    end <= start ||
    source.indexOf("const compiledChannel =", start + 1) >= 0
  ) {
    throw new Error("compiled license binding segment is missing or ambiguous");
  }
  const binding = source.slice(start, end);
  // electron-vite inlines the define; the return may be a bare candidate
  // (older fixture) or the post-compile channel ternary (current main).
  const channel = exactlyOneMatch(
    binding,
    /const candidate = "(development|beta|production)";\s*return candidate(?: === "beta" \|\| candidate === "production" \? candidate : "development")?;/gu,
    "channel",
  );
  const businessId = exactlyOneMatch(
    binding,
    /businessId: compiledString\(\s*"([^"]*)"\s*\)/gu,
    "business ID",
  );
  const productId = exactlyOneMatch(
    binding,
    /productId: compiledString\(\s*"([^"]*)"\s*\)/gu,
    "product ID",
  );
  const resolved = resolveLicenseBuildProfile({
    channel,
    businessId,
    productId,
  });
  if (
    expected !== undefined &&
    (resolved.channel !== expected.channel ||
      resolved.environment !== expected.environment ||
      resolved.businessId !== expected.businessId ||
      resolved.productId !== expected.productId)
  ) {
    throw new Error("compiled license binding differs from the selected profile");
  }
  return {
    ...resolved,
    entry: PACKAGED_LICENSE_MAIN_ENTRY,
    bytes: bytes.byteLength,
  };
};

export const auditLicenseBundle = async (
  bundlePath: string,
  expected?: ReleaseLicenseBuildProfile,
): Promise<LicenseBuildAuditReceipt> =>
  auditCompiledLicenseMain(await readFile(bundlePath), expected);

export const auditPackagedLicenseBinding = (
  appAsarPath: string,
): LicenseBuildAuditReceipt => {
  const entry = statFile(appAsarPath, PACKAGED_LICENSE_MAIN_ENTRY, false);
  if (
    !("size" in entry) ||
    entry.unpacked ||
    entry.size < 1 ||
    entry.size > MAX_LICENSE_MAIN_BYTES
  ) {
    throw new Error(
      "packaged license main must be one bounded packed regular file",
    );
  }
  const bytes = extractFile(appAsarPath, PACKAGED_LICENSE_MAIN_ENTRY, false);
  if (bytes.byteLength !== entry.size) {
    throw new Error("packaged license main changed size during audit");
  }
  return auditCompiledLicenseMain(bytes);
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const args = process.argv.slice(2);
  const expectedEnvIndex = args.indexOf("--expected-env");
  const expectsEnvironment = expectedEnvIndex >= 0;
  if (expectsEnvironment) args.splice(expectedEnvIndex, 1);
  if (args.length !== 2 || args[0] !== "--bundle") {
    console.error(
      "usage: bun scripts/audit-license-build.ts --bundle <out/main/index.js> [--expected-env]",
    );
    process.exitCode = 2;
  } else {
    let expected: ReleaseLicenseBuildProfile | undefined;
    try {
      expected = expectsEnvironment
        ? resolveLicenseBuildProfile({
            channel: process.env.VELLUM_LICENSE_CHANNEL,
            businessId: process.env.VELLUM_DODO_BUSINESS_ID,
            productId: process.env.VELLUM_DODO_PRODUCT_ID,
          })
        : undefined;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`vellum license build audit failed: ${message}`);
      process.exitCode = 1;
    }
    if (process.exitCode !== 1) {
      auditLicenseBundle(path.resolve(args[1]!), expected)
        .then((receipt) => {
          process.stdout.write(
            `${JSON.stringify({ ok: true, license: receipt })}\n`,
          );
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`vellum license build audit failed: ${message}`);
          process.exitCode = 1;
        });
    }
  }
}
