import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import {
  admitStagedMacApp,
  type AdmitStagedMacAppOptions,
} from "./admit-mac-app";
import { updateError } from "./errors";

const STAGING_MODE = 0o700;

export type StagedCandidateBundle = {
  readonly stagingRoot: string;
  readonly appPath: string;
  readonly executablePath: string;
};

export type ExpandMacUpdateZipOptions = AdmitStagedMacAppOptions;

const assertRealDirectory = (path: string): void => {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`staging path is not a real directory: ${path}`);
  }
};

const findAppBundle = (root: string): string => {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.endsWith(".app")) {
      return join(root, entry.name);
    }
  }
  // electron-builder sometimes nests the app one level down
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const nested = join(root, entry.name);
    try {
      return findAppBundle(nested);
    } catch {
      // keep searching
    }
  }
  throw new Error("staged update ZIP does not contain a .app bundle");
};

const resolveMacExecutable = (appPath: string): string => {
  const contents = join(appPath, "Contents");
  const macos = join(contents, "MacOS");
  assertRealDirectory(macos);
  const binaries = readdirSync(macos).filter((name) => !name.startsWith("."));
  if (binaries.length === 0) {
    throw new Error("staged .app has no MacOS executable");
  }
  // Prefer the product name; fall back to the first binary.
  const preferred =
    binaries.find((name) => name === "Vellum Command") ?? binaries[0]!;
  const executablePath = join(macos, preferred);
  const info = lstatSync(executablePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("staged MacOS executable is not a regular file");
  }
  return executablePath;
};

const runDittoExtract = (
  zipPath: string,
  destination: string,
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      "/usr/bin/ditto",
      ["-x", "-k", zipPath, destination],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `ditto extract failed (exit ${String(code)}): ${stderr.trim() || "no stderr"}`,
        ),
      );
    });
  });

/**
 * Expand the exact downloaded ZIP to a disposable proof-only staging directory,
 * then admit the staged `.app` (Developer ID + product identity) before the
 * path is admitted for installation. Never installs to /Applications —
 * electron-updater owns the real swap.
 */
export const expandMacUpdateZip = async (
  zipPath: string,
  options: ExpandMacUpdateZipOptions = {},
): Promise<StagedCandidateBundle> => {
  let stagingRoot: string | undefined;
  try {
    const resolvedZip = resolve(zipPath);
    const zipInfo = lstatSync(resolvedZip);
    if (!zipInfo.isFile() || zipInfo.isSymbolicLink()) {
      throw new Error("update ZIP is not a regular file");
    }
    stagingRoot = mkdtempSync(join(tmpdir(), "vellum-command-update-proof-"));
    chmodSync(stagingRoot, STAGING_MODE);
    await runDittoExtract(resolvedZip, stagingRoot);
    assertRealDirectory(stagingRoot);
    const appPath = findAppBundle(stagingRoot);
    const executablePath = resolveMacExecutable(appPath);
    await admitStagedMacApp(appPath, options);
    return { stagingRoot, appPath, executablePath };
  } catch (cause) {
    discardStaging(stagingRoot);
    throw updateError("readiness-failed",
      cause instanceof Error ? `failed to admit update ZIP: ${cause.message}` : "failed to admit update ZIP", cause);
  }
};

const discardStaging = (stagingRoot: string | undefined): void => {
  if (stagingRoot === undefined) return;
  try { rmSync(stagingRoot, { recursive: true, force: true }); }
  catch { /* Disposable proof cleanup cannot block installation. */ }
};

export const releaseStaging = (
  stagingRoot: string | undefined,
): Effect.Effect<void> => Effect.sync(() => discardStaging(stagingRoot));
