/**
 * TerminalSessions — sole product seam for herdr control streams.
 *
 * Consolidation: IPC, message delivery, and Effect callers enter here.
 * HerdrStreamManager is an implementation detail of this service (and
 * HerdrPlane internals for observe handoff / revocation). Product code must
 * not call plane.streams.* for open/write/close.
 *
 * - open / openScoped: product open; scoped variant detaches on Scope close
 * - *Wire helpers: IPC-stable { ok, error } / open result shapes
 */

import { Context, Effect, type Scope } from "effect";
import type {
  HerdrPointerCell,
  HerdrRetainedPayload,
  HerdrStreamOpenInput,
  HerdrStreamOpenResult,
} from "@shared/ipc";
import {
  terminalSpawnError,
  type HerdrControlError,
  type HerdrControlWriteResult,
  type TerminalSpawnError,
} from "@shared/terminal-session-domain";
import type { HerdrStreamFrame, HerdrStreamManager } from "../herdr/stream";

export type HerdrControlOpenInput = HerdrStreamOpenInput;

export type HerdrControlLiveHandle = {
  readonly streamId: string;
  readonly terminalId: string;
  readonly retained: HerdrRetainedPayload;
};

export type ProductWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type ProductPasteResult = ProductWriteResult & { readonly path?: string };

export type FrameSink = (frame: HerdrStreamFrame) => void;

/** The stable capability shape shared by the V3 bridge and the V4 service. */
export interface TerminalSessionsApi {
  /** Long-lived product open (IPC / message path). Does not Scope-bind. */
  readonly open: (
    input: HerdrControlOpenInput,
  ) => Effect.Effect<HerdrControlLiveHandle, TerminalSpawnError>;

  /**
   * Scoped open: detach on Scope close / interrupt. Prefer for Effect
   * workflows that own a temporary control generation.
   */
  readonly openScoped: (
    input: HerdrControlOpenInput,
  ) => Effect.Effect<
    HerdrControlLiveHandle,
    TerminalSpawnError,
    Scope.Scope
  >;

  readonly inputBytes: (
    streamId: string,
    dataBase64: string,
  ) => Effect.Effect<void, HerdrControlError>;
  readonly inputText: (
    streamId: string,
    text: string,
  ) => Effect.Effect<void, HerdrControlError>;
  readonly resize: (
    streamId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, HerdrControlError>;
  readonly scroll: (
    streamId: string,
    delta: number,
    at?: HerdrPointerCell,
  ) => Effect.Effect<void, HerdrControlError>;
  readonly pasteImage: (
    streamId: string,
    extension: string,
    dataBase64: string,
  ) => Effect.Effect<ProductPasteResult, never>;
  readonly close: (
    streamId: string,
    reason?: string,
  ) => Effect.Effect<void>;

  /** IPC / sync product open result. */
  readonly openProduct: (input: HerdrControlOpenInput) => HerdrStreamOpenResult;
  readonly inputBytesProduct: (
    streamId: string,
    dataBase64: string,
  ) => ProductWriteResult;
  readonly inputTextProduct: (
    streamId: string,
    text: string,
  ) => ProductWriteResult;
  readonly resizeProduct: (
    streamId: string,
    cols: number,
    rows: number,
  ) => ProductWriteResult;
  readonly scrollProduct: (
    streamId: string,
    delta: number,
    at?: HerdrPointerCell,
  ) => ProductWriteResult;
  readonly pasteImageProduct: (
    streamId: string,
    extension: string,
    dataBase64: string,
  ) => Promise<ProductPasteResult>;
  readonly closeProduct: (
    streamId: string,
    reason?: string,
  ) => ProductWriteResult;

  readonly setFrameSink: (sink: FrameSink | undefined) => void;
  /** Message-delivery retry when control attaches for a terminal. */
  readonly setOpenHook: (hook: ((terminalId: string) => void) | undefined) => void;
  readonly activeControlCount: () => number;
  readonly streamIdForTerminal: (terminalId: string) => string | undefined;
}

/**
 * V4 migration map (effect@3.21 keeps the compiling bridge for now):
 *
 *   Context.Service<TerminalSessions, TerminalSessionsApi>()(
 *     "@vellum/TerminalSessions",
 *   )
 *
 * There is one identifier and one shape. Do not add a second Tag, a Default
 * layer, or a compatibility accessor; replace the bridge directly at the V4
 * dependency cutover.
 */
export class TerminalSessions extends Context.Service<TerminalSessions,
  TerminalSessionsApi>()("@vellum/TerminalSessions") {}

const writeFromWire = (
  result: HerdrControlWriteResult,
): Effect.Effect<void, HerdrControlError> =>
  result.ok ? Effect.void : Effect.fail(result.cause);

/** IPC-stable wire shape for the product (sync-IPC) write methods. */
const toProductResult = (result: HerdrControlWriteResult): ProductWriteResult =>
  result.ok ? { ok: true } : { ok: false, error: result.cause.message };

const openFromManager = (
  streams: HerdrStreamManager,
  input: HerdrControlOpenInput,
): Effect.Effect<HerdrControlLiveHandle, TerminalSpawnError> =>
  Effect.suspend(() => {
    const opened = streams.open(input);
    if (!opened.ok) {
      return Effect.fail(terminalSpawnError("herdr-control", opened.message));
    }
    return Effect.succeed({
      streamId: opened.streamId,
      terminalId: input.terminalId,
      retained: opened.retained,
    } satisfies HerdrControlLiveHandle);
  });

export const makeTerminalSessions = (
  streams: HerdrStreamManager,
): Context.Service.Shape<typeof TerminalSessions> => {
  const open = (input: HerdrControlOpenInput) => openFromManager(streams, input);

  const openScoped = (input: HerdrControlOpenInput) =>
    Effect.acquireRelease(open(input), (handle, exit) =>
      Effect.sync(() => {
        const reason =
          exit._tag === "Failure" ? "scope_release_failed" : "scope_release";
        streams.close(handle.streamId, reason);
      }),
    );

  const openProduct = (input: HerdrControlOpenInput): HerdrStreamOpenResult => {
    const opened = streams.open(input);
    if (!opened.ok) return { ok: false, message: opened.message };
    return {
      ok: true,
      streamId: opened.streamId,
      retained: opened.retained,
    };
  };

  return TerminalSessions.of({
    open,
    openScoped,
    inputBytes: (streamId, dataBase64) =>
      writeFromWire(streams.input(streamId, dataBase64)),
    inputText: (streamId, text) => writeFromWire(streams.inputText(streamId, text)),
    resize: (streamId, cols, rows) =>
      writeFromWire(streams.resize(streamId, cols, rows)),
    scroll: (streamId, delta, at) =>
      writeFromWire(streams.scroll(streamId, delta, at)),
    pasteImage: (streamId, extension, dataBase64) =>
      Effect.promise(() => streams.pasteImage(streamId, extension, dataBase64)),
    close: (streamId, reason = "client_close") =>
      Effect.sync(() => {
        streams.close(streamId, reason);
      }),

    openProduct,
    inputBytesProduct: (streamId, dataBase64) =>
      toProductResult(streams.input(streamId, dataBase64)),
    inputTextProduct: (streamId, text) =>
      toProductResult(streams.inputText(streamId, text)),
    resizeProduct: (streamId, cols, rows) =>
      toProductResult(streams.resize(streamId, cols, rows)),
    scrollProduct: (streamId, delta, at) =>
      toProductResult(streams.scroll(streamId, delta, at)),
    pasteImageProduct: (streamId, extension, dataBase64) =>
      streams.pasteImage(streamId, extension, dataBase64),
    closeProduct: (streamId, reason = "client_close") => {
      const result = streams.close(streamId, reason);
      return result.ok
        ? { ok: true as const }
        : { ok: false as const, error: result.error ?? "close failed" };
    },

    setFrameSink: (sink) => streams.setSink(sink),
    setOpenHook: (hook) => streams.setOpenHook(hook),
    activeControlCount: () => streams.activeControlCount(),
    streamIdForTerminal: (terminalId) => streams.streamIdForTerminal(terminalId),
  });
};

// TerminalSessionsLive lives in runtime.ts (needs HerdrPlane) to avoid
// plane ↔ sessions import cycles.
