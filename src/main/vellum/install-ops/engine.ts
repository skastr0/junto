import {
  chmodSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import {
  INSTALL_OPS_SCHEMA_SQL,
} from "./schema";
import {
  InstallOpsError,
  InstallOpsService,
  type BackfillMarker,
  type BackfillMarkerStatus,
  type InstallOpsServiceShape,
} from "./service";
import { installOpsDatabasePath } from "./paths";

export { BACKFILL_INLINE_MEDIA_V1, INSTALL_OPS_SCHEMA_VERSION } from "./schema";
export { installOpsDatabasePath } from "./paths";
export {
  InstallOpsError,
  InstallOpsService,
  type BackfillMarker,
  type BackfillMarkerStatus,
  type InstallOpsServiceShape,
} from "./service";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5_000;

const opsError = (
  operation: string,
  cause: unknown,
): InstallOpsError =>
  cause instanceof InstallOpsError
    ? cause
    : new InstallOpsError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

const assertRealDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`install-ops path is not a real directory: ${path}`);
  }
  chmodSync(path, DIR_MODE);
};

const openInstallOps = (path: string) =>
  Effect.try({
    try: () => {
      assertRealDirectory(dirname(path));
      const database = new DatabaseSync(path);
      try {
        database.exec("PRAGMA busy_timeout = " + String(BUSY_TIMEOUT_MS));
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = NORMAL");
        database.exec("PRAGMA foreign_keys = ON");
        database.exec(INSTALL_OPS_SCHEMA_SQL);

        try {
          chmodSync(path, FILE_MODE);
        } catch {
          // Best-effort mode on platforms that ignore chmod.
        }

        const getRow = database.prepare(
          `
            SELECT id, status, objects_ingested, completed_at
            FROM backfill_markers
            WHERE id = ?
          `,
        );
        const ensurePending = database.prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, 'pending', 0, NULL)
            ON CONFLICT(id) DO NOTHING
          `,
        );
        const reopenPending = database.prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, 'pending', 0, NULL)
            ON CONFLICT(id) DO UPDATE SET
              status = 'pending',
              completed_at = NULL
          `,
        );
        const markComplete = database.prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, 'complete', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = 'complete',
              objects_ingested = excluded.objects_ingested,
              completed_at = excluded.completed_at
          `,
        );

        let closed = false;
        const service: InstallOpsServiceShape = {
          path,
          getBackfill: (id) =>
            Effect.try({
              try: () => {
                const row = getRow.get(id) as
                  | {
                    readonly id: string;
                    readonly status: string;
                    readonly objects_ingested: number | bigint;
                    readonly completed_at: string | null;
                  }
                  | undefined;
                if (row === undefined) return undefined;
                if (row.status !== "pending" && row.status !== "complete") {
                  throw new Error(`invalid backfill status: ${row.status}`);
                }
                return {
                  id: row.id,
                  status: row.status as BackfillMarkerStatus,
                  objectsIngested: Number(row.objects_ingested),
                  completedAt: row.completed_at ?? undefined,
                } satisfies BackfillMarker;
              },
              catch: (cause) => opsError("getBackfill", cause),
            }),
          ensurePending: (id) =>
            Effect.try({
              try: () => {
                ensurePending.run(id);
              },
              catch: (cause) => opsError("ensurePending", cause),
            }),
          reopenPending: (id) =>
            Effect.try({
              try: () => {
                reopenPending.run(id);
              },
              catch: (cause) => opsError("reopenPending", cause),
            }),
          markComplete: (id, objectsIngested) =>
            Effect.try({
              try: () => {
                markComplete.run(
                  id,
                  objectsIngested,
                  new Date().toISOString(),
                );
              },
              catch: (cause) => opsError("markComplete", cause),
            }),
        };

        return {
          service,
          close: () => {
            if (closed) return;
            closed = true;
            database.close();
          },
        };
      } catch (cause) {
        try {
          database.close();
        } catch {
          // Preserve the setup error; the close was still attempted.
        }
        throw cause;
      }
    },
    catch: (cause) => opsError("open", cause),
  });

export const makeInstallOpsLive = (
  path?: string,
): Layer.Layer<InstallOpsService, InstallOpsError> =>
  Layer.effect(
    InstallOpsService,
    Effect.acquireRelease(
      openInstallOps(path ?? installOpsDatabasePath()),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.map(({ service }) => service)),
  );

export const InstallOpsLive = makeInstallOpsLive();
