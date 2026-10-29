/**
 * The host of this machine's canvas authorities (0.11/06 F2): one open
 * handle per canvas, opened as a batch first needs it. A handle is dropped
 * and the canvas opened again when it broke, and when the canvas it was
 * opened for is gone: a canvas deleted and made again under its name is
 * another canvas, with another id and its own log.
 *
 * Nothing drives ticks or carries messages yet; a canvas this machine rules
 * alone commits as it appends, which is every canvas until F6 lists a pair.
 */
import { Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { InstallationId } from "@shared/installation-id";
import { MachineRepository } from "../machines/repository";
import { RulingRecorder } from "../work/ruling-recorder";
import { CanvasAuthorities } from "./authorities";
import { FleetDriverError, judgingCanvas, openCanvasAuthority, outsideTransactions, type CanvasAuthority } from "./driver";

export const makeCanvasAuthorities = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const recorder = yield* RulingRecorder;
  const machines = yield* MachineRepository;
  const held = new Map<string, { readonly authority: CanvasAuthority; readonly canvasId: string }>();
  const opening = Semaphore.makeUnsafe(1);

  /** The canvas's handle, as the canvas now stands: the one held, or a new one in place of a broken or stale one. */
  const authorityOf = (canvasName: string) =>
    opening.withPermits(1)(
      Effect.gen(function* () {
        const [row] = yield* sql<{ canvas_id: string }>`SELECT canvas_id FROM canvases WHERE canvas_name = ${canvasName}`.pipe(
          Effect.mapError((cause) => new FleetDriverError({ message: `the canvas ${canvasName} could not be read`, cause })),
        );
        const current = held.get(canvasName);
        if (current !== undefined && current.authority.usable() && current.canvasId === row?.canvas_id) return current.authority;
        if (current !== undefined) {
          // Closed before it is forgotten: a refused close leaves it held, never open and unheld.
          yield* current.authority.close();
          held.delete(canvasName);
        }
        if (row === undefined) return yield* Effect.fail(new FleetDriverError({ message: `there is no canvas ${canvasName}`, cause: canvasName }));
        const self: InstallationId = yield* machines.installationId.pipe(
          Effect.mapError((cause) => new FleetDriverError({ message: "this machine's installation could not be read", cause })),
        );
        const authority = yield* openCanvasAuthority({ canvasName, self }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(RulingRecorder, recorder),
        );
        held.set(canvasName, { authority, canvasId: row.canvas_id });
        return authority;
      }),
    );

  return CanvasAuthorities.of({
    judge: (canvasName, batch) =>
      Effect.flatMap(judgingCanvas, (outer) =>
        outer !== undefined
          // Opened inside a batch, a canvas's log would begin in a savepoint that rolls back.
          ? Effect.fail(new FleetDriverError({ message: `a batch for ${outer} reached the authority of ${canvasName}: a batch is judged by one canvas, and drives no authority itself`, cause: { outer, canvasName } }))
          : outsideTransactions(sql, canvasName).pipe(
            Effect.andThen(authorityOf(canvasName)),
            Effect.flatMap((authority) => authority.judge(batch)),
          )),
  });
});

export const CanvasAuthoritiesLive: Layer.Layer<CanvasAuthorities, never, SqlClient.SqlClient | RulingRecorder | MachineRepository> =
  Layer.effect(CanvasAuthorities, makeCanvasAuthorities);
