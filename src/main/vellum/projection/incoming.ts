/**
 * Remote station: apply Command Center projection frames from the drop path.
 *
 * Drop: `~/.vellum/projections/incoming.frame` (staged by compileProjectionFrameDeliver).
 * Apply: generation-gated station store install → materialize canvas docs →
 * optional live authority swap → consume drop file.
 *
 * Fail closed: corrupt/stale frames leave live authority untouched; drop is
 * not consumed on rejection so a re-push can overwrite the drop path.
 */

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  canvasPullFileName,
  canvasNameFromListingEntry,
} from "@shared/canvas-pull";
import {
  PROJECTION_DROP_RELATIVE_DIR,
  PROJECTION_INCOMING_BASENAME,
} from "../ssh/remote-plan";
import {
  preparePulledCanvasBody,
  writeStagedCanvasFile,
  applyStagedCanvasProjection,
} from "../canvas-pull";
import { canvasNameFrom, ensureCanvasesDir } from "../canvases";
import {
  applyStationProjectionGeneration,
  stationProjectionRoot,
  type ApplyStationProjectionResult,
} from "./station-store";

export const projectionDropRoot = (): string =>
  resolve(
    process.env.VELLUM_PROJECTION_DROP_DIR ||
      join(homedir(), ".vellum", PROJECTION_DROP_RELATIVE_DIR),
  );

export const incomingProjectionFramePath = (
  dropRoot: string = projectionDropRoot(),
): string => join(dropRoot, PROJECTION_INCOMING_BASENAME);

export type ApplyIncomingProjectionResult =
  | { readonly status: "absent" }
  | {
      readonly status: "applied";
      readonly generation: string;
      readonly frameSha256: string;
      readonly names: ReadonlyArray<string>;
      readonly store: ApplyStationProjectionResult;
      readonly detail: string;
    }
  | {
      readonly status: "idempotent";
      readonly generation: string;
      readonly frameSha256: string;
      readonly names: ReadonlyArray<string>;
      readonly store: ApplyStationProjectionResult;
      readonly detail: string;
    }
  | {
      readonly status: "rejected";
      readonly detail: string;
    };

export type ApplyIncomingProjectionDeps = {
  /** Station projection store root (tests inject temp dirs). */
  readonly storeRoot?: string;
  /** Drop directory containing incoming.frame. */
  readonly dropRoot?: string;
  /** Admit installed canvas names into live authority after disk materialize. */
  readonly replaceLiveAuthority?: (
    names: ReadonlyArray<string>,
  ) => Promise<void>;
};

const readIncomingFrame = async (
  path: string,
): Promise<
  | { readonly ok: true; readonly frame: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: "absent" | "rejected";
      readonly detail: string;
    }
> => {
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const file = await open(path, constants.O_RDONLY | noFollow);
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        return {
          ok: false,
          reason: "rejected",
          detail: "incoming.frame is not a regular file",
        };
      }
      if (info.size <= 0 || info.size > 16 * 1024 * 1024) {
        return {
          ok: false,
          reason: "rejected",
          detail: `incoming.frame size out of bounds (${info.size})`,
        };
      }
      const buf = await file.readFile();
      return { ok: true, frame: new Uint8Array(buf) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "absent", detail: "no incoming frame" };
    }
    return {
      ok: false,
      reason: "rejected",
      detail: `failed to read incoming.frame: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

const consumeIncomingFrame = async (
  path: string,
  dropRoot: string,
): Promise<void> => {
  const consumed = join(dropRoot, `incoming.frame.applied.${randomUUID()}`);
  try {
    await rename(path, consumed);
    await rm(consumed, { force: true }).catch(() => undefined);
  } catch {
    await rm(path, { force: true }).catch(() => undefined);
  }
};

const deleteLocalCanvasesAbsentFrom = async (
  keepNames: ReadonlyArray<string>,
): Promise<void> => {
  const targetDir = await ensureCanvasesDir();
  const keep = new Set(keepNames.map(canvasPullFileName));
  const entries = await readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || keep.has(entry.name)) continue;
    const name = canvasNameFromListingEntry(entry.name);
    if (name === undefined) continue;
    const path = join(targetDir, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await rm(path);
    } catch {
      /* best-effort mirror reconcile */
    }
  }
};

/**
 * If `incoming.frame` is present, install it into the station projection store
 * and replace local canvas documents (+ optional live authority).
 */
export const applyIncomingProjectionFrame = async (
  deps: ApplyIncomingProjectionDeps = {},
): Promise<ApplyIncomingProjectionResult> => {
  const dropRoot = deps.dropRoot ?? projectionDropRoot();
  const framePath = incomingProjectionFramePath(dropRoot);

  const loaded = await readIncomingFrame(framePath);
  if (!loaded.ok) {
    if (loaded.reason === "absent") return { status: "absent" };
    return { status: "rejected", detail: loaded.detail };
  }

  let storeResult: ApplyStationProjectionResult;
  try {
    storeResult = await applyStationProjectionGeneration(
      { kind: "frame", frame: loaded.frame },
      deps.storeRoot ?? stationProjectionRoot(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "rejected",
      detail: message.slice(0, 4_096),
    };
  }

  const stageDir = join(
    await ensureCanvasesDir(),
    `.projection-stage-${randomUUID()}`,
  );
  const names: string[] = [];
  try {
    await mkdir(stageDir, { recursive: true, mode: 0o700 });

    const snapshotDocs = storeResult.snapshot.documents;
    const staged = [];
    for (const [rawName, bodyBytes] of snapshotDocs) {
      const name = canvasNameFrom(rawName);
      const raw = new TextDecoder().decode(bodyBytes);
      const prepared = preparePulledCanvasBody(name, raw);
      if (!prepared.ok) {
        return {
          status: "rejected",
          detail: prepared.detail,
        };
      }
      staged.push(await writeStagedCanvasFile(stageDir, name, prepared.body));
      names.push(name);
    }
    names.sort((a, b) => a.localeCompare(b));
    await applyStagedCanvasProjection(stageDir, staged);
    await deleteLocalCanvasesAbsentFrom(names);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "rejected",
      detail: `materialize failed after store install: ${message}`.slice(
        0,
        4_096,
      ),
    };
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (deps.replaceLiveAuthority) {
    try {
      await deps.replaceLiveAuthority(names);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "rejected",
        detail: `live authority admit failed: ${message}`.slice(0, 4_096),
      };
    }
  }

  await consumeIncomingFrame(framePath, dropRoot);

  if (storeResult.status === "idempotent") {
    return {
      status: "idempotent",
      generation: storeResult.generation,
      frameSha256: storeResult.frameSha256,
      names,
      store: storeResult,
      detail: `idempotent re-apply of generation ${storeResult.generation}`,
    };
  }

  return {
    status: "applied",
    generation: storeResult.generation,
    frameSha256: storeResult.frameSha256,
    names,
    store: storeResult,
    detail: `installed generation ${storeResult.generation} (${names.length} canvas(es))`,
  };
};
