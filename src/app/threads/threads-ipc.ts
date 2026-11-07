/**
 * The window's mail threads, seat views and collaboration asks, asked of the
 * core's threads group (src/contract/core/threads.ts). What the renderer sends
 * is decoded here, closed, so the core is only ever handed input that decoded.
 * A thread read that does not decode rejects the call; a mark that does not
 * decode answers undefined, and a send that does not decode answers refused,
 * as before. A send is two calls: the write runs under the authoring gate
 * main hands in, and delivery follows it outside the gate.
 *
 * Read points that move and mail held past its wait come back as pushes once
 * the core is asked to watch, which main asks of every core.
 */
import type { IpcMain } from "electron";
import { Context, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  decodeOperatorThreadSend,
  decodeSeatThreadMarkRead,
  decodeSeatThreadPageQuery,
  decodeSeatThreadReadsQuery,
  decodeSeatThreadsPageQuery,
  decodeSeatThreadsQuery,
  type MailReadPoint,
  type OperatorThreadSent,
} from "@shared/mail-threads";
import type { SeatCollaborationAskResult, SeatCollaborationDraft } from "@shared/seat-collaboration";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "../../contract/core/channels";
import { ThreadsCore } from "../../contract/core/threads";
import { askOnEveryCore } from "../core-process/every-core";
import { CorePushesMain } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

/** A write under its main authoring label, so shutdown drains it. */
type Authored = <A>(operation: () => Promise<A>) => Promise<A>;

export const registerThreadsIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<ThreadsCore | CorePushesMain>,
  authoring: { readonly send: Authored },
): void => {
  const threads = Context.get(core, ThreadsCore);
  const pushes = Context.get(core, CorePushesMain);

  ipc.handle(IPC_CHANNELS.agentSeatStateSnapshot, () => AppRuntime.runPromise(threads.ThreadsSeatStates()));

  ipc.handle(IPC_CHANNELS.agentSeatViewed, async (_event, bindingId: unknown) => {
    if (typeof bindingId !== "string" || bindingId.length === 0) return;
    await AppRuntime.runPromise(threads.ThreadsSeatViewed({ bindingId }));
  });

  // Mail threads, for a seat's Threads popup: reads through the shared
  // derivation, and the operator's send into a thread.
  ipc.handle(IPC_CHANNELS.seatThreadsList, (_event, input: unknown) => {
    const query = decodeSeatThreadsPageQuery(input);
    return Result.isFailure(query)
      ? Promise.reject(new Error(query.failure.message))
      : AppRuntime.runPromise(threads.ThreadsList(query.success));
  });
  ipc.handle(IPC_CHANNELS.seatThreadMessages, (_event, input: unknown) => {
    const query = decodeSeatThreadPageQuery(input);
    return Result.isFailure(query)
      ? Promise.reject(new Error(query.failure.message))
      : AppRuntime.runPromise(threads.ThreadsMessages(query.success));
  });
  ipc.handle(IPC_CHANNELS.seatThreadMentionables, (_event, input: unknown) => {
    const query = decodeSeatThreadsQuery(input);
    return Result.isFailure(query)
      ? Promise.reject(new Error(query.failure.message))
      : AppRuntime.runPromise(threads.ThreadsMentionables(query.success));
  });
  // The operator's read points, one per thread and shared with the phone
  // (work/mail-reads.ts). A mark never rejects: a refusal is undefined.
  ipc.handle(IPC_CHANNELS.seatThreadReads, (_event, input: unknown) => {
    const query = decodeSeatThreadReadsQuery(input);
    return Result.isFailure(query)
      ? Promise.reject(new Error(query.failure.message))
      : AppRuntime.runPromise(threads.ThreadsReads(query.success));
  });
  // The header's count: every thread of the seat, never the page the list holds.
  ipc.handle(IPC_CHANNELS.seatThreadUnread, async (_event, input: unknown): Promise<number | undefined> => {
    const query = decodeSeatThreadReadsQuery(input);
    if (Result.isFailure(query)) throw new Error(query.failure.message);
    return (await AppRuntime.runPromise(threads.ThreadsUnread(query.success))) ?? undefined;
  });
  ipc.handle(IPC_CHANNELS.seatThreadMarkRead, async (_event, input: unknown): Promise<MailReadPoint | undefined> => {
    const mark = decodeSeatThreadMarkRead(input);
    if (Result.isFailure(mark)) return undefined;
    return (await AppRuntime.runPromise(threads.ThreadsMarkRead(mark.success)).catch(() => null)) ?? undefined;
  });
  pushes.subscribe(SEAT_THREAD_READ_CHANGED, (change) => broadcast(IPC_CHANNELS.seatThreadReadChanged, change));
  pushes.subscribe(MAIL_WAITING, (fact) => broadcast(IPC_CHANNELS.mailWaiting, fact));
  askOnEveryCore("threads.watch", () => AppRuntime.runPromise(threads.ThreadsWatch()));

  /** The write: input that does not decode is refused here, as the core refused it before. */
  const write = async (input: unknown) => {
    const send = decodeOperatorThreadSend(input);
    if (Result.isFailure(send)) {
      return { ok: false, reason: "invalid", message: "That mail could not be read." } satisfies OperatorThreadSent;
    }
    return AppRuntime.runPromise(threads.ThreadsWrite(send.success));
  };
  ipc.handle(IPC_CHANNELS.seatThreadSend, async (_event, input: unknown): Promise<OperatorThreadSent> => {
    try {
      // The write alone holds the authoring gate; delivery follows it, as before.
      const sent = await authoring.send(() => write(input));
      if ("ok" in sent) return sent;
      return await AppRuntime.runPromise(threads.ThreadsDeliver(sent));
    } catch {
      // Fixed words: a thrown error may carry the mail's text.
      return { ok: false, reason: "failed", message: "The mail could not be sent." };
    }
  });

  ipc.handle(IPC_CHANNELS.mailWaitingRead, () => AppRuntime.runPromise(threads.ThreadsMailWaiting()));
  ipc.handle(IPC_CHANNELS.seatOnboardingSnapshot, () => AppRuntime.runPromise(threads.ThreadsOnboarding()));
};

/** The core's answer to a collaboration ask the operator made; a failure rejects with what the core said. */
export const askCollaboration = (
  core: Context.Context<ThreadsCore>,
  draft: SeatCollaborationDraft,
): Promise<SeatCollaborationAskResult> => AppRuntime.runPromise(Context.get(core, ThreadsCore).ThreadsCollaborationAsk({ draft }));
