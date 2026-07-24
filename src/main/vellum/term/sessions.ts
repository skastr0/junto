/**
 * TerminalSessions — Effect seam over herdr control streams (Phase B).
 *
 * Pristine: Effect signature = open/write/close with tagged errors + Scope release.
 * Plastic: delegates to HerdrStreamManager (Node stdio, spawn, IPC sink).
 *
 * Scope acquireRelease ensures detach on fiber interrupt / scope close so
 * "remember to close" is construction-level, not folklore.
 */

import { Context, Effect, Layer, Ref, type Scope } from "effect";
import type { HerdrPointerCell, HerdrRetainedPayload } from "@shared/ipc";
import {
  inactiveControlError,
  terminalSpawnError,
  type HerdrControlError,
  type TerminalSpawnError,
} from "@shared/terminal-session-domain";
import type { HerdrStreamManager } from "../herdr/stream";
import { HerdrPlane } from "../herdr/plane";

export type HerdrControlOpenInput = {
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly takeover?: boolean;
};

export type HerdrControlLiveHandle = {
  readonly streamId: string;
  readonly terminalId: string;
  readonly retained: HerdrRetainedPayload;
};

export class TerminalSessions extends Context.Tag("@vellum/TerminalSessions")<
  TerminalSessions,
  {
    /**
     * Open herdr control for a terminal. Same terminalId supersedes prior
     * control (stream manager product law). Scope release detaches.
     */
    readonly openHerdrControl: (
      input: HerdrControlOpenInput,
    ) => Effect.Effect<
      HerdrControlLiveHandle,
      TerminalSpawnError | HerdrControlError,
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
    readonly close: (
      streamId: string,
      reason?: string,
    ) => Effect.Effect<void>;
    readonly activeControlCount: () => number;
    /** terminalId → live streamId (for message delivery / supersede inspection). */
    readonly streamIdForTerminal: (terminalId: string) => string | undefined;
  }
>() {}

const writeFromWire = (
  result: { readonly ok: true } | { readonly ok: false; readonly error: string },
): Effect.Effect<void, HerdrControlError> =>
  result.ok
    ? Effect.void
    : Effect.fail(inactiveControlError(result.error));

export const makeTerminalSessions = (
  streams: HerdrStreamManager,
): Context.Tag.Service<typeof TerminalSessions> => {
  const openHerdrControl = (
    input: HerdrControlOpenInput,
  ): Effect.Effect<
    HerdrControlLiveHandle,
    TerminalSpawnError | HerdrControlError,
    Scope.Scope
  > =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const opened = streams.open(input);
        if (!opened.ok) {
          return Effect.fail(
            terminalSpawnError("herdr-control", opened.message),
          );
        }
        return Effect.succeed({
          streamId: opened.streamId,
          terminalId: input.terminalId,
          retained: opened.retained,
        } satisfies HerdrControlLiveHandle);
      }),
      (handle, exit) =>
        Effect.sync(() => {
          // Interrupt / scope end always detaches; already-closed is ok.
          const reason =
            exit._tag === "Failure" ? "scope_release_failed" : "scope_release";
          streams.close(handle.streamId, reason);
        }),
    );

  return TerminalSessions.of({
    openHerdrControl,
    inputBytes: (streamId, dataBase64) =>
      writeFromWire(streams.input(streamId, dataBase64)),
    inputText: (streamId, text) => writeFromWire(streams.inputText(streamId, text)),
    resize: (streamId, cols, rows) =>
      writeFromWire(streams.resize(streamId, cols, rows)),
    scroll: (streamId, delta, at) =>
      writeFromWire(streams.scroll(streamId, delta, at)),
    close: (streamId, reason = "client_close") =>
      Effect.sync(() => {
        streams.close(streamId, reason);
      }),
    activeControlCount: () => streams.activeControlCount(),
    streamIdForTerminal: (terminalId) => streams.streamIdForTerminal(terminalId),
  });
};

/** Layer: TerminalSessions from live HerdrPlane streams. */
export const TerminalSessionsLive = Layer.effect(
  TerminalSessions,
  Effect.gen(function* () {
    const plane = yield* HerdrPlane;
    return makeTerminalSessions(plane.streams);
  }),
);

/**
 * Track last opened stream per terminalId for Effect callers that supersede
 * without going through openHerdrControl's internal detach (optional helper).
 */
export const makeTerminalSupersedeIndex = (): Effect.Effect<
  {
    readonly note: (terminalId: string, streamId: string) => Effect.Effect<void>;
    readonly current: (terminalId: string) => Effect.Effect<string | undefined>;
    readonly clear: (terminalId: string) => Effect.Effect<void>;
  },
  never,
  never
> =>
  Effect.gen(function* () {
    const map = yield* Ref.make(new Map<string, string>());
    return {
      note: (terminalId, streamId) =>
        Ref.update(map, (m) => {
          const next = new Map(m);
          next.set(terminalId, streamId);
          return next;
        }),
      current: (terminalId) =>
        Ref.get(map).pipe(Effect.map((m) => m.get(terminalId))),
      clear: (terminalId) =>
        Ref.update(map, (m) => {
          const next = new Map(m);
          next.delete(terminalId);
          return next;
        }),
    };
  });
