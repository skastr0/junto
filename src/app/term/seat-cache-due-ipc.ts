/**
 * The auto cache mode's question and the operator's offboard buttons, for the
 * window (junto/ipc.ts). Both are the core's, where the seats and their views
 * run (src/contract/core/seat-cache-due.ts): the seats due the question, here
 * and on linked machines, the operator's answer, and offboard ask or now, on
 * one seat or many, with what the buttons should say first. The same
 * operation the overseer and the automatic rules go through
 * (seat-sessions/operator-offboard.ts).
 *
 * The window's input is decoded closed here, at main's edge; input this build
 * does not read is answered as the core answers a refusal, and never sent on.
 */
import type { IpcMain } from "electron";
import { Context, Result, Schema } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { SeatCacheDueAnswerResult } from "@shared/seat-cache-due";
import { summarizeOffboardRun, type SeatOffboardRunResult, type SeatOffboardStatus } from "@shared/seat-offboard";
import { SEAT_CACHE_DUE_CHANGED } from "../../contract/core/channels";
import {
  SeatCacheDueAnswerInput,
  SeatCacheDueCore,
  SeatOffboardRunInput,
  SeatOffboardStatusAsk,
} from "../../contract/core/seat-cache-due";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

const decodeAnswer = Schema.decodeUnknownResult(SeatCacheDueAnswerInput);
const decodeRun = Schema.decodeUnknownResult(SeatOffboardRunInput);
const decodeStatus = Schema.decodeUnknownResult(SeatOffboardStatusAsk);

export const registerSeatCacheDueIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<SeatCacheDueCore>,
): void => {
  const due = Context.get(core, SeatCacheDueCore);
  const list = () => AppRuntime.runPromise(due.SeatCacheDueList());

  // The whole list of seats due the question, in order: a later push never lands before an earlier one.
  let pushed: Promise<void> = Promise.resolve();
  const push = (): void => {
    pushed = pushed
      .then(async () => broadcast(IPC_CHANNELS.seatCacheDue, await list()))
      .catch((error: unknown) => console.error("[offboard] the seats due a choice could not be told:", error));
  };
  onCorePush(SEAT_CACHE_DUE_CHANGED, () => push());

  ipc.handle(IPC_CHANNELS.seatCacheDueList, () => list());
  ipc.handle(IPC_CHANNELS.seatCacheDueAnswer, (_event, raw: unknown): Promise<SeatCacheDueAnswerResult> => {
    const input = decodeAnswer(raw, { onExcessProperty: "error" });
    if (Result.isFailure(input)) return Promise.resolve({ ok: false, message: "Start fresh, or keep this session." });
    return AppRuntime.runPromise(due.SeatCacheDueAnswer({ input: input.success }));
  });
  ipc.handle(IPC_CHANNELS.seatOffboardRun, (_event, raw: unknown): Promise<SeatOffboardRunResult> => {
    const input = decodeRun(raw, { onExcessProperty: "error" });
    if (Result.isFailure(input)) return Promise.resolve(summarizeOffboardRun([]));
    return AppRuntime.runPromise(due.SeatCacheDueOffboardRun({ input: input.success }));
  });
  ipc.handle(
    IPC_CHANNELS.seatOffboardStatus,
    (_event, canvasName: unknown, seatIds: unknown): Promise<ReadonlyArray<SeatOffboardStatus>> => {
      const ask = decodeStatus({ canvasName, seatIds }, { onExcessProperty: "error" });
      if (Result.isFailure(ask)) return Promise.resolve([]);
      return AppRuntime.runPromise(due.SeatCacheDueOffboardStatus(ask.success));
    },
  );
};
