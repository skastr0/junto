import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canvasControlNameFrom } from "./protocol";

const CANVAS_SIDECAR_SUFFIXES = ["digest.txt", "svg"] as const;
export type CanvasSidecarSuffix = (typeof CANVAS_SIDECAR_SUFFIXES)[number];

const canvasSidecarRoot = (): string =>
  resolve(
    process.env.VELLUM_CANVASES_DIR ??
      join(homedir(), ".vellum", "canvases"),
  );

const confinedSidecarPath = (
  root: string,
  name: string,
  suffix: CanvasSidecarSuffix,
): string => {
  const path = resolve(root, `${canvasControlNameFrom(name)}.${suffix}`);
  if (dirname(path) !== root) {
    throw new Error("canvas sidecar path escaped its output directory");
  }
  return path;
};

const ensureSidecarRoot = async (): Promise<string> => {
  const root = canvasSidecarRoot();
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`canvas sidecar root is not a real directory: ${root}`);
  }
  return root;
};

const assertRegularOrMissing = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `refusing non-regular canvas sidecar: ${basename(path)}`,
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
      "[canvas-sidecar] directory sync failed after committed write:",
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
  suffix: CanvasSidecarSuffix,
  contents: string,
): Promise<string> => {
  if (!CANVAS_SIDECAR_SUFFIXES.includes(suffix)) {
    throw new Error(`unsupported canvas sidecar suffix "${String(suffix)}"`);
  }
  const root = await ensureSidecarRoot();
  const path = confinedSidecarPath(root, name, suffix);
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
