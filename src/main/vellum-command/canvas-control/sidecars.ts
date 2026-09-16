import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolveVellumCommandHome } from "@shared/vellum-home";
import { basename, dirname, join, resolve } from "node:path";
import { canvasControlNameFrom } from "./protocol";

const CANVAS_PROJECTION_SUFFIXES = ["digest.txt", "svg"] as const;
export type CanvasProjectionSuffix =
  (typeof CANVAS_PROJECTION_SUFFIXES)[number];

const canvasProjectionRoot = (): string =>
  resolve(
    process.env.JUNTO_CANVASES_DIR ??
      join(resolveVellumCommandHome(), ".vellum-command", "canvases"),
  );

const canvasProjectionSuffixFrom = (
  raw: string,
): CanvasProjectionSuffix => {
  if (
    !CANVAS_PROJECTION_SUFFIXES.includes(raw as CanvasProjectionSuffix)
  ) {
    throw new Error(`unsupported canvas projection suffix "${raw}"`);
  }
  return raw as CanvasProjectionSuffix;
};

const confinedProjectionPath = (
  root: string,
  canonicalName: string,
  suffix: CanvasProjectionSuffix,
): string => {
  const path = resolve(root, `${canonicalName}.${suffix}`);
  if (dirname(path) !== root) {
    throw new Error("canvas projection path escaped its output directory");
  }
  return path;
};

const assertProjectionRoot = async (root: string): Promise<void> => {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`canvas projection root is not a real directory: ${root}`);
  }
};

const ensureProjectionRoot = async (): Promise<string> => {
  const root = canvasProjectionRoot();
  await mkdir(root, { recursive: true });
  await assertProjectionRoot(root);
  return root;
};

const assertRegularOrMissing = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `refusing non-regular canvas projection: ${basename(path)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
};

const syncDirectoryBestEffort = async (root: string): Promise<void> => {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(root, "r");
    await directory.sync();
  } catch (error) {
    // The rename is already committed. Retrying would be less safe than
    // retaining the derivative and surfacing the durability limitation.
    console.error(
      "[canvas-projection] directory sync failed after committed write:",
      error,
    );
  } finally {
    await directory?.close().catch(() => undefined);
  }
};

const writeExclusiveTemp = async (
  path: string,
  contents: string,
): Promise<void> => {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, { encoding: "utf8" });
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** Write an allowlisted derivative; this is output, never product authority. */
export const writeCanvasProjectionSidecar = async (
  name: string,
  rawSuffix: string,
  contents: string,
): Promise<string> => {
  const suffix = canvasProjectionSuffixFrom(rawSuffix);
  const canonicalName = canvasControlNameFrom(name);
  const root = await ensureProjectionRoot();
  const path = confinedProjectionPath(root, canonicalName, suffix);
  await assertRegularOrMissing(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    await writeExclusiveTemp(temporaryPath, contents);
    ownsTemporary = true;
    await rename(temporaryPath, path);
    ownsTemporary = false;
  } catch (error) {
    if (ownsTemporary) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  await syncDirectoryBestEffort(root);
  return path;
};

/**
 * Remove every projection output belonging to one canvas.
 *
 * Missing roots and outputs are already the desired state. A present root is
 * still verified before any deletion; no document or arbitrary suffix is ever
 * accepted by this sink.
 */
export const removeCanvasProjectionSidecars = async (
  name: string,
): Promise<void> => {
  const canonicalName = canvasControlNameFrom(name);
  const root = canvasProjectionRoot();
  try {
    await assertProjectionRoot(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const suffix of CANVAS_PROJECTION_SUFFIXES) {
    const path = confinedProjectionPath(root, canonicalName, suffix);
    await rm(path, { force: true });
  }
  await syncDirectoryBestEffort(root);
};
