/**
 * Remote station: apply Command Center projection frames from the drop path.
 *
 * Drop: `~/.vellum/projections/incoming.frame` (staged by delivery).
 * Apply: station verify → generation-gated station store install → decode
 * complete document set → replace live authority in one generation → consume
 * drop file.
 *
 * Fail closed: wrong role/target/corrupt/stale frames leave live authority
 * untouched; drop is not consumed on rejection so a re-push can overwrite.
 */

import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "@shared/canvas";
import {
  PROJECTION_DROP_RELATIVE_DIR,
  PROJECTION_INCOMING_BASENAME,
} from "../ssh/remote-plan";
import { canvasNameFrom } from "../canvases";
import { parseStationProjectionFrame } from "./compiler";
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
  /**
   * Replace live authority with the fully decoded projection document set.
   * Required for product apply; tests may omit to exercise store-only path.
   */
  readonly replaceLiveAuthorityDocuments?: (
    documents: ReadonlyMap<string, CanvasDoc>,
  ) => Promise<void>;
  /**
   * Sealed local station role. Product path must pass `"remote"`.
   * When provided and not `"remote"`, apply fails closed.
   */
  readonly localStationRole?: string;
  /**
   * Local `stationSettingsWitness`. When provided, must equal the frame's
   * `targetWitness` (wrong-target fail closed).
   */
  readonly localStationWitness?: string;
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

/**
 * Station verify gates (fail closed, no mutation):
 * - sealed local role is Remote when role is provided
 * - targetWitness equals local station witness when local witness is provided
 * - generation newer or same+hash (idempotent) — enforced by station store
 */
const verifyStationProjectionAdmission = (
  frame: Uint8Array,
  deps: ApplyIncomingProjectionDeps,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string } => {
  let parsed;
  try {
    parsed = parseStationProjectionFrame(frame);
  } catch (error) {
    return {
      ok: false,
      detail: (error instanceof Error ? error.message : String(error)).slice(
        0,
        4_096,
      ),
    };
  }

  if (deps.localStationRole !== undefined && deps.localStationRole !== "remote") {
    return {
      ok: false,
      detail: `projection apply requires Remote station role (got ${JSON.stringify(deps.localStationRole)})`,
    };
  }

  if (deps.localStationWitness !== undefined) {
    if (parsed.manifest.targetWitness !== deps.localStationWitness) {
      return {
        ok: false,
        detail:
          "projection targetWitness does not match local station witness",
      };
    }
  }

  return { ok: true };
};

/**
 * If `incoming.frame` is present, install it into the station projection store
 * and replace live authority with the complete decoded document set.
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

  const verified = verifyStationProjectionAdmission(loaded.frame, deps);
  if (!verified.ok) {
    return { status: "rejected", detail: verified.detail };
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

  const documents = new Map<string, CanvasDoc>();
  const names: string[] = [];
  for (const [rawName, bodyBytes] of storeResult.snapshot.documents) {
    let name: string;
    try {
      name = canvasNameFrom(rawName);
    } catch (error) {
      return {
        status: "rejected",
        detail: `invalid canvas name in frame: ${rawName} (${
          error instanceof Error ? error.message : String(error)
        })`.slice(0, 4_096),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch (error) {
      return {
        status: "rejected",
        detail: `canvas "${name}" is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 4_096),
      };
    }
    const decoded = decodeCanvasDoc(parsed);
    if (Either.isLeft(decoded)) {
      return {
        status: "rejected",
        detail: `canvas "${name}" failed validation: ${decoded.left.message}`.slice(
          0,
          4_096,
        ),
      };
    }
    documents.set(name, decoded.right);
    names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));

  if (deps.replaceLiveAuthorityDocuments) {
    try {
      await deps.replaceLiveAuthorityDocuments(documents);
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
