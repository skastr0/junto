/**
 * The window's seat calls over IPC: the region environment's report, secrets
 * and out-of-date seats, the pause plane's state and set, the operator's
 * prompt to a managed seat, the operator's offboard ask and where each
 * offboard stands, and the onboarding nudge. Each one asks the core's seats
 * group (src/contract/core/seats.ts).
 *
 * What the window sends is decoded here, at main's edge, closed, so the core
 * is only ever handed typed values. A call the window sent that does not
 * decode is answered with the same refusal the core gives a seat or region it
 * cannot find, in the operator's words, and never reaches the core.
 */
import type { IpcMain } from "electron";
import { Context, type Effect, Result, Schema } from "effect";
import type { RpcClientError } from "effect/rpc";
import { IPC_CHANNELS } from "@shared/ipc";
import { PAUSED_CANVAS } from "@shared/pause";
import { OFFBOARD_MODES } from "@shared/seat-sessions";
import { RegionEnvSaveSecretInput, SeatId, SeatPromptInput, SeatsCore } from "../../contract/core/seats";
import { AppRuntime } from "../runtime";

/** Untrusted input is decoded closed: a field this build does not read refuses the call. */
const closed = { onExcessProperty: "error" } as const;

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const decodeRegion = Schema.decodeUnknownResult(Schema.Tuple([Schema.String, Schema.String]));
const decodeSaveSecret = Schema.decodeUnknownResult(RegionEnvSaveSecretInput);
const decodeCanvas = Schema.decodeUnknownResult(Schema.String);
const decodePauseSet = Schema.decodeUnknownResult(Schema.Tuple([Schema.String, Schema.Boolean]));
const decodePrompt = Schema.decodeUnknownResult(SeatPromptInput);
const decodeSeat = Schema.decodeUnknownResult(Schema.Tuple([NonEmpty, SeatId]));
const decodeMode = Schema.decodeUnknownResult(Schema.Literals(OFFBOARD_MODES));
const decodeNudgeSeat = Schema.decodeUnknownResult(Schema.Tuple([NonEmpty, NonEmpty]));

const NOT_A_REGION = "That region is not on this canvas.";
const NOT_FOUND = "Junto could not find that seat.";

export const registerSeatsIpc = (ipc: Pick<IpcMain, "handle">, core: Context.Context<SeatsCore>): void => {
  const seats = Context.get(core, SeatsCore);
  const ask = <A>(call: Effect.Effect<A, RpcClientError.RpcClientError>): Promise<A> => AppRuntime.runPromise(call);

  // Region environment: Junto's own secret store on this machine, held by the
  // core. The value arrives once and no answer returns it. An install-local
  // store like seat guidance (no canvas authoring), so it runs outside the
  // main-authoring gate.
  ipc.handle(IPC_CHANNELS.regionEnvSaveSecret, (_event, raw: unknown) => {
    const input = decodeSaveSecret(raw, closed);
    if (Result.isFailure(input)) return Promise.resolve({ ok: false as const, message: "There is no secret to save." });
    // regionId and name are context from the screen; the store keeps neither.
    const { value, secretId } = input.success;
    return ask(seats.SeatsRegionEnvSaveSecret({ value, ...(secretId === undefined ? {} : { secretId }) }));
  });
  ipc.handle(IPC_CHANNELS.regionEnvRemoveSecret, (_event, raw: unknown) => {
    const secretId = decodeCanvas(raw, closed);
    // Removing what is not a secret id removes nothing, and succeeds.
    if (Result.isFailure(secretId)) return Promise.resolve({ ok: true as const });
    return ask(seats.SeatsRegionEnvRemoveSecret({ secretId: secretId.success }));
  });
  // Read-only: names, kinds, origins and status of what a region resolves to.
  ipc.handle(IPC_CHANNELS.regionEnvReport, (_event, canvasName: unknown, regionId: unknown) => {
    const target = decodeRegion([canvasName, regionId], closed);
    if (Result.isFailure(target)) return Promise.resolve({ ok: false as const, message: NOT_A_REGION });
    const [canvas, region] = target.success;
    return ask(seats.SeatsRegionEnvReport({ canvasName: canvas, regionId: region }));
  });
  ipc.handle(IPC_CHANNELS.regionEnvStaleSeats, (_event, canvasName: unknown, regionId: unknown) => {
    const target = decodeRegion([canvasName, regionId], closed);
    if (Result.isFailure(target)) return Promise.resolve({ ok: false as const, message: NOT_A_REGION });
    const [canvas, region] = target.success;
    return ask(seats.SeatsRegionEnvStaleSeats({ canvasName: canvas, regionId: region }));
  });

  // A canvas this build cannot name has no recorded play decision: it is paused.
  ipc.handle(IPC_CHANNELS.factoryPauseState, (_event, canvas: unknown) => {
    const named = decodeCanvas(canvas, closed);
    if (Result.isFailure(named)) return Promise.resolve(PAUSED_CANVAS);
    return ask(seats.SeatsFactoryPauseState({ canvas: named.success }));
  });
  ipc.handle(IPC_CHANNELS.factoryPauseSet, (_event, canvas: unknown, paused: unknown) => {
    const set = decodePauseSet([canvas, paused], closed);
    if (Result.isFailure(set)) return Promise.resolve({ ok: false as const, error: "That pause switch could not be read." });
    const [named, pause] = set.success;
    return ask(seats.SeatsFactoryPauseSet({ canvas: named, paused: pause }));
  });

  ipc.handle(IPC_CHANNELS.terminalManagedPrompt, (_event, raw: unknown) => {
    const input = decodePrompt(raw, closed);
    if (Result.isFailure(input)) {
      return Promise.resolve({ ok: false as const, disposition: "failed" as const, error: "that prompt could not be read" });
    }
    return ask(seats.SeatsManagedPrompt({ input: input.success }));
  });

  // Offboard: the operator asks from the seat, the agent writes its notes
  // with `junto offboard`, and the core's closer ends the session once the
  // agent is idle, in the mode the agent chose.
  ipc.handle(IPC_CHANNELS.seatOffboardProgressList, () => ask(seats.SeatsOffboardProgress()));
  ipc.handle(IPC_CHANNELS.seatOffboardAsk, (_event, canvasName: unknown, seatId: unknown, mode: unknown) => {
    const seat = decodeSeat([canvasName, seatId], closed);
    if (Result.isFailure(seat)) return Promise.resolve({ ok: false as const, message: NOT_FOUND });
    const offboard = decodeMode(mode, closed);
    if (Result.isFailure(offboard)) return Promise.resolve({ ok: false as const, message: "Offboard to rest or to continue." });
    const [canvas, id] = seat.success;
    return ask(seats.SeatsOffboardAsk({ canvasName: canvas, seatId: id, mode: offboard.success }));
  });
  ipc.handle(IPC_CHANNELS.seatOnboardNudge, (_event, canvasName: unknown, seatId: unknown) => {
    const seat = decodeNudgeSeat([canvasName, seatId], closed);
    if (Result.isFailure(seat)) return Promise.resolve({ ok: false as const, message: NOT_FOUND });
    const [canvas, id] = seat.success;
    return ask(seats.SeatsOnboardNudge({ canvasName: canvas, seatId: id }));
  });
};
