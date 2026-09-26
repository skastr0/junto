/**
 * One companion connection: the stdio side of junto-companion/1.
 *
 * `hello` goes out before any request is read. Requests are pipelined and each
 * response is written as soon as its host call settles. A subscription
 * (`feed.subscribe`, and every `seats.list` canvas) turns the host's change
 * notifications into events: `signal.changed` for each signal upsert, and
 * `feed.changed` / `seat.changed` only when the whole feed of a canvas, or one
 * seat, actually differs from what this connection last sent. A channel silent
 * for two minutes is closed.
 *
 * The host is the running app (relayed over the operator socket) or the
 * built-in demo; the session does not know which.
 */

import type { AgentSignal } from "./agent-signals";
import {
  COMPANION_IDLE_CLOSE_MS,
  COMPANION_PROTOCOL,
  companionConnectionErrorLine,
  companionEvent,
  companionFail,
  decodeCompanionRequestLine,
  encodeCompanionFrame,
  type CompanionError,
  type CompanionHello,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
  type CompanionSeat,
} from "./companion-protocol";
import type { OperatorFeed } from "./operator-feed";

export type CompanionChange = {
  readonly cursor: string;
  /** Something the feed or a seat reads may have changed. */
  readonly changed: boolean;
  /** Signal upserts since the cursor, oldest first. */
  readonly signals: ReadonlyArray<AgentSignal>;
  /** The cursor was not recognized (app restarted): refresh everything. */
  readonly reset: boolean;
};

export type CompanionHost = {
  readonly hello: () => Promise<
    { readonly ok: true; readonly hello: CompanionHello } | { readonly ok: false; readonly error: CompanionError }
  >;
  readonly call: (frame: CompanionRequestFrame) => Promise<CompanionResponseFrame>;
  /** Resolves on the next change after `cursor`, or after `waitMs` with `changed: false`. */
  readonly waitChange: (cursor: string | undefined, waitMs: number) => Promise<CompanionChange>;
};

export type CompanionSessionIo = {
  readonly lines: AsyncIterable<string>;
  readonly write: (line: string) => void;
  readonly host: CompanionHost;
  readonly idleCloseMs?: number;
  /** Long-poll window for change notifications. */
  readonly waitMs?: number;
};

/** A feed with its clock fields zeroed: two feeds that say the same thing compare equal. */
const feedKey = (feed: OperatorFeed): string =>
  JSON.stringify({
    ...feed,
    generatedAt: 0,
    sections: feed.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, ageMs: 0 })),
    })),
  });

const seatKey = (seat: CompanionSeat): string => JSON.stringify(seat);

type Next = { readonly kind: "line"; readonly line: string } | { readonly kind: "end" } | { readonly kind: "idle" };

export const runCompanionSession = async (io: CompanionSessionIo): Promise<void> => {
  const idleMs = io.idleCloseMs ?? COMPANION_IDLE_CLOSE_MS;
  const waitMs = io.waitMs ?? 25_000;
  let open = true;
  const write = (line: string): void => {
    if (open) io.write(line);
  };

  const hello = await io.host.hello().catch(() => ({
    ok: false as const,
    error: { code: "app-not-running" as const, message: "Junto is not open on the Mac." },
  }));
  if (!hello.ok) {
    write(companionConnectionErrorLine(hello.error.code, hello.error.message));
    return;
  }
  write(encodeCompanionFrame(companionEvent("hello", hello.hello)));

  // --- subscriptions and events ---------------------------------------------
  let feedSubscription: { readonly canvasName: string | undefined } | undefined;
  const sentFeeds = new Map<string, string>();
  const seatCanvases = new Map<string, Map<string, string>>();
  let eventLoop: Promise<void> | undefined;
  let internalId = 0;
  const internal = (op: "feed.get" | "seats.list", canvasName: string | undefined): CompanionRequestFrame =>
    ({
      v: COMPANION_PROTOCOL,
      type: "request",
      id: `_event.${(internalId += 1)}`,
      op,
      args: canvasName === undefined ? {} : { canvasName },
    }) as CompanionRequestFrame;

  const rememberFeeds = (feeds: ReadonlyArray<OperatorFeed>): void => {
    for (const feed of feeds) sentFeeds.set(feed.canvasName, feedKey(feed));
  };
  const rememberSeats = (canvasName: string, seats: ReadonlyArray<CompanionSeat>): void => {
    seatCanvases.set(canvasName, new Map(seats.map((seat) => [seat.nodeId, seatKey(seat)])));
  };

  const refresh = async (): Promise<void> => {
    if (feedSubscription) {
      const response = await io.host.call(internal("feed.get", feedSubscription.canvasName));
      if (response.ok && "feeds" in response.result) {
        for (const feed of response.result.feeds) {
          const key = feedKey(feed);
          if (sentFeeds.get(feed.canvasName) === key) continue;
          sentFeeds.set(feed.canvasName, key);
          write(encodeCompanionFrame(companionEvent("feed.changed", { feed })));
        }
      }
    }
    for (const [canvasName, known] of seatCanvases) {
      const response = await io.host.call(internal("seats.list", canvasName));
      if (!response.ok || !("seats" in response.result)) continue;
      for (const seat of response.result.seats) {
        const key = seatKey(seat);
        if (known.get(seat.nodeId) === key) continue;
        known.set(seat.nodeId, key);
        write(encodeCompanionFrame(companionEvent("seat.changed", { canvasName, seat })));
      }
    }
  };

  const subscribed = (): boolean => feedSubscription !== undefined || seatCanvases.size > 0;

  const runEvents = async (): Promise<void> => {
    let cursor: string | undefined;
    while (open && subscribed()) {
      let change: CompanionChange;
      try {
        change = await io.host.waitChange(cursor, waitMs);
      } catch {
        // The app went away mid-poll; the next request will say so.
        return;
      }
      if (!open) return;
      const first = cursor === undefined;
      cursor = change.cursor;
      if (first && !change.reset) continue;
      if (feedSubscription) {
        const filter = feedSubscription.canvasName;
        for (const signal of change.signals) {
          if (filter !== undefined && signal.canvasName !== filter) continue;
          write(encodeCompanionFrame(companionEvent("signal.changed", { signal })));
        }
      }
      if (change.changed || change.reset || change.signals.length > 0) {
        await refresh().catch(() => undefined);
      }
    }
  };
  const ensureEvents = (): void => {
    if (eventLoop === undefined && subscribed()) {
      eventLoop = runEvents().finally(() => {
        eventLoop = undefined;
      });
    }
  };

  // --- requests ---------------------------------------------------------------
  const pending = new Set<Promise<void>>();
  const handle = async (frame: CompanionRequestFrame): Promise<void> => {
    let response: CompanionResponseFrame;
    try {
      response = await io.host.call(frame);
    } catch {
      response = companionFail(frame.id, { code: "app-not-running", message: "Junto is not open on the Mac." });
    }
    if (response.ok) {
      if (frame.op === "feed.subscribe" && "feeds" in response.result) {
        feedSubscription = { canvasName: frame.args.canvasName };
        sentFeeds.clear();
        rememberFeeds(response.result.feeds);
      } else if (frame.op === "feed.unsubscribe") {
        feedSubscription = undefined;
        sentFeeds.clear();
      } else if (frame.op === "seats.list" && "seats" in response.result) {
        rememberSeats(frame.args.canvasName, response.result.seats);
      }
    }
    write(encodeCompanionFrame(response));
    ensureEvents();
  };

  const iterator = io.lines[Symbol.asyncIterator]();
  const next = (): Promise<Next> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "idle" }), idleMs);
      void iterator.next().then(
        (step) => {
          clearTimeout(timer);
          resolve(step.done ? { kind: "end" } : { kind: "line", line: step.value });
        },
        () => {
          clearTimeout(timer);
          resolve({ kind: "end" });
        },
      );
    });

  try {
    for (;;) {
      const step = await next();
      if (step.kind !== "line") break;
      const line = step.line.replace(/\r$/u, "");
      if (line.trim() === "") continue;
      const decoded = decodeCompanionRequestLine(line);
      if (decoded._tag === "Failure") {
        const failure = decoded.failure;
        write(
          failure.id === ""
            ? companionConnectionErrorLine(failure.error.code, failure.error.message)
            : encodeCompanionFrame(companionFail(failure.id, failure.error)),
        );
        if (failure.close) break;
        continue;
      }
      const flight = handle(decoded.success);
      pending.add(flight);
      void flight.finally(() => pending.delete(flight));
    }
  } finally {
    await Promise.allSettled([...pending]);
    open = false;
    void iterator.return?.();
  }
};
