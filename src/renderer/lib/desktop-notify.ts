import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type {
  NotifyReport,
  NotifySubject,
  NotifyTarget,
} from "@shared/desktop-notifications";
import { deriveNeeds, type NeedCause, type SeatSnapshot } from "@shared/harness-domain";
import { nodesOf, type Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { feedStopOf, isMailWaitingItem, type OperatorFeed } from "@shared/operator-feed";
import { notifyNeed } from "@shared/need-surfaces";
import { notificationSettings } from "@shared/settings";
import type { PreambleEvent } from "@shared/preamble";
import { activateNodeSurface } from "./activate-node-surface";
import { agentSeat$, presentationForSeat, seatDoneAt, seatStatusForBinding } from "./agent-seat-state";
import { getJuntoApi } from "./junto-api";
import { useOperatorFeed } from "./operator-feed";
import { openOperatorModal } from "./operator-modal";
import { isThisMacItem } from "./phone-reach";
import { playNotificationCue } from "./sound";
import { state$ } from "./state";
import { terminal$ } from "./terminal-state";
import { onTerminalEvent } from "./terminal-events";
import { useCanvas } from "./use-model";

/**
 * The renderer's half of desktop notifications: it knows what needs the
 * operator, main knows whether they are looking. Every change to the open
 * needs goes to main as one report (main decides what becomes a banner and
 * keeps the Dock badge); a clicked banner comes back here to open the seat
 * or the feed, and a posted banner's cue plays here, since banners are
 * silent.
 *
 * Three sources, each already shown in the app:
 * - the ⌘I feed's declared signals and proven needs-input. The AI's advisory
 *   reading and the needs read off the canvas are listed there but do not
 *   ping;
 * - seats that finished a turn the operator has not looked at (done);
 * - agent seats that stopped: a failure exit until the seat starts again, or
 *   a status stopped on a usage limit nothing wakes, a sign-in error or a
 *   crash; and squads that could not finish starting.
 *
 * Each subject carries its need's category and rung from the one need
 * ladder (`notifyNeed`), so the policy ranks needs the way every surface
 * does.
 */

/** A need's category and rung; every cause asked for here is one notifications show. */
const shown = (cause: NeedCause) => {
  const need = notifyNeed(cause);
  if (need === undefined) throw new Error(`desktop notifications do not show ${cause}`);
  return need;
};

const FAILED_EXIT = shown("unexpected_exit");
const FINISHED = shown("turn_unseen");
/** A squad that could not finish starting reads as a crash. */
const SQUAD_FAILED = shown("crash");

type Failure = { readonly epoch: string; readonly code: number };

/** Failed agent generations by binding, until that binding starts again. */
export const seatFailures$ = observable<Record<string, Failure | undefined>>({});
/**
 * Squad failures, raised once by squad placement and kept long enough to
 * settle into a banner. They are events, not states, so they age out.
 */
type RaisedFailure = NotifySubject & { readonly until: number };
const raisedFailures$ = observable<ReadonlyArray<RaisedFailure>>([]);
export const RAISED_FAILURE_MS = 120_000;

/** A squad could not finish starting: its name, one of its seats, and what went wrong. */
export const raiseSquadFailure = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly squadName: string;
  readonly text: string;
  readonly now?: number;
}): void => {
  const now = input.now ?? Date.now();
  const live = raisedFailures$.peek().filter((failure) => failure.until > now);
  raisedFailures$.set([
    ...live,
    {
      key: `squad:${input.nodeId}:${now}`,
      ...SQUAD_FAILED,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      seatName: input.squadName,
      text: input.text,
      until: now + RAISED_FAILURE_MS,
    },
  ]);
  setTimeout(() => {
    const at = Date.now();
    raisedFailures$.set(raisedFailures$.peek().filter((failure) => failure.until > at));
  }, RAISED_FAILURE_MS + 50);
};

/** The agent's own last words per seat (its `junto preamble`), for a finish line. */
const lastSaid$ = observable<Record<string, string | undefined>>({});

/**
 * The need behind each feed kind that pings. A proven needs-input row is a
 * permission, question or dialog, all one rung.
 */
const FEED_NEED = {
  blocked: shown("seat_blocked"),
  attention: shown("dialog"),
  escalate: shown("seat_escalated"),
  feedback: shown("seat_feedback"),
} as const;

/**
 * Feed items as subjects. The AI's reading, canvas needs and held mail never
 * ping (held mail is display only: an attention row, but not a dialog); a
 * stopped seat pings through seatSubjects, as it did before the feed listed it.
 * This Mac's own item is found as the window regains focus, with the operator
 * already here: it counts, but it never pings.
 */
export const subjectsFromFeed = (feed: OperatorFeed): ReadonlyArray<NotifySubject> =>
  feed.sections.flatMap((section) =>
    section.items.flatMap((item): ReadonlyArray<NotifySubject> =>
      item.kind === "health" || item.kind === "stopped" || item.canvas === true || isThisMacItem(item) || isMailWaitingItem(item)
        ? []
        : [
            {
              // A seat's attention row keeps one id; each new ask is its own subject.
              key: item.kind === "attention" ? `${item.itemId}:${item.since ?? 0}` : item.itemId,
              ...FEED_NEED[item.kind],
              canvasName: item.canvasName,
              nodeId: item.seat.nodeId,
              seatName: item.seat.name,
              text: item.text,
            },
          ],
    ),
  );

/** Finished-not-read seats and failed seats on the canvas, as subjects. */
export const seatSubjects = (input: {
  readonly canvasName: string;
  readonly seats: ReadonlyArray<Seat>;
  readonly seatState: (bindingId: string) => { readonly state: string; readonly at: number } | undefined;
  readonly needsLook: (bindingId: string) => boolean;
  /** When the unread finished turn ended; the need's identity. */
  readonly doneAt?: (bindingId: string) => number | undefined;
  readonly failure: (bindingId: string) => Failure | undefined;
  readonly exitMessage: (bindingId: string) => string | undefined;
  readonly lastSaid: (nodeId: string) => string | undefined;
  /** The seat's harness status, when its latest event carries one. */
  readonly status?: (bindingId: string) => SeatSnapshot | undefined;
  readonly now?: number;
}): ReadonlyArray<NotifySubject> => {
  const now = input.now ?? Date.now();
  const out: NotifySubject[] = [];
  for (const node of input.seats) {
    const bindingId = node.bindingId;
    const seat = { canvasName: input.canvasName, nodeId: node.id, seatName: titleOf(node) };
    const failure = input.failure(bindingId);
    if (failure) {
      out.push({
        ...seat,
        key: `failed:${node.id}:${failure.epoch}`,
        ...FAILED_EXIT,
        text: input.exitMessage(bindingId) ?? `ended with exit code ${failure.code}`,
      });
      continue;
    }
    const snapshot = input.status?.(bindingId);
    const stop = snapshot === undefined ? undefined : stopOf(snapshot);
    if (snapshot !== undefined && stop !== undefined) {
      out.push({
        ...seat,
        key: `stopped:${node.id}:${stop.since}`,
        category: stop.category,
        level: stop.level,
        // The feed's own sentence for the stop, so both surfaces say it alike.
        text: feedStopOf(snapshot, now)?.text ?? "stopped",
      });
      continue;
    }
    const event = input.seatState(bindingId);
    if (!event) continue;
    const presentation = presentationForSeat(event.state as never, input.needsLook(bindingId));
    if (presentation !== "done") continue;
    out.push({
      ...seat,
      // One need per finished turn. The seat's latest event is not it: main
      // re-sends a seat whose reason changes with a new time, and a new key
      // would be a second banner and cue for the same turn.
      key: `done:${node.id}:${input.doneAt?.(bindingId) ?? event.at}`,
      ...FINISHED,
      text: input.lastSaid(node.id) ?? "finished and is waiting for you to look",
    });
  }
  return out;
};

/**
 * A stop the seat's status shows: a usage limit nothing wakes, a sign-in
 * error, a crash. An exit is the exit path's, which knows its code.
 */
const stopOf = (snapshot: SeatSnapshot) => {
  for (const need of deriveNeeds(snapshot)) {
    if (need.cause === "unexpected_exit") continue;
    const notified = notifyNeed(need.cause);
    if (notified?.category === "failed") return { ...notified, since: need.since };
  }
  return undefined;
};

/** A report's identity for change detection: what main would act on. */
const reportKey = (report: NotifyReport): string => JSON.stringify(report);

/**
 * The one report for the open canvas. Rebuilt on every render: the seat and
 * terminal stores mutate in place, so identity-keyed memos would go stale,
 * and the build is a pass over the agent seats. The effect below sends only
 * a report whose content changed.
 */
const useNotifyReport = (): NotifyReport | null => {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  const settings = use$(state$.settings);
  const settingsReady = use$(state$.settingsReady);
  const feed = useOperatorFeed();
  use$(agentSeat$.rev);
  const needsLook = use$(agentSeat$.needsLookByBindingId);
  const failures = use$(seatFailures$);
  const lastSaid = use$(lastSaid$);
  const sessions = use$(terminal$.sessionByBindingId);
  const raised = use$(raisedFailures$);
  if (!canvasName || !settingsReady) return null;
  const seats = seatSubjects({
    canvasName,
    seats: nodesOf(canvas, "agent"),
    seatState: (bindingId) => agentSeat$.byBindingId[bindingId].peek(),
    needsLook: (bindingId) => needsLook[bindingId] === true,
    doneAt: seatDoneAt,
    failure: (bindingId) => failures[bindingId],
    exitMessage: (bindingId) => sessions[bindingId]?.exitMessage?.trim() || undefined,
    lastSaid: (nodeId) => lastSaid[nodeId],
    status: (bindingId) => seatStatusForBinding(bindingId)?.snapshot,
  });
  // A seat both in the feed and finished or stopped posts once: the policy
  // keeps each seat's most urgent need.
  return {
    canvasName,
    subjects: [
      ...subjectsFromFeed(feed),
      ...seats,
      ...raised
        .filter((failure) => failure.canvasName === canvasName)
        .map(({ until: _until, ...subject }) => subject),
    ],
    badge: feed.count,
    prefs: notificationSettings(settings),
  };
};

/** Open what a clicked banner points at: the seat's focus view, else the feed. */
export const openNotifyTarget = (target: NotifyTarget): void => {
  if (!target.canvasName) return;
  if (target.kind === "seat" && target.canvasName === state$.canvasName.peek()) {
    if (activateNodeSurface(target.nodeId).opened) return;
  }
  openOperatorModal("feed");
};

const failureOf = (event: unknown): { readonly bindingId: string; readonly failure?: Failure } | undefined => {
  if (typeof event !== "object" || event === null) return undefined;
  const value = event as Record<string, unknown>;
  if (typeof value.bindingId !== "string" || typeof value.epoch !== "string") return undefined;
  if (value.type === "session" && value.status !== "exited") return { bindingId: value.bindingId };
  if (value.type !== "exit") return undefined;
  const code = value.code;
  // A clean exit or a signal (the operator's stop, quit) is not a failure.
  if (typeof code !== "number" || code === 0 || value.signal !== undefined) return undefined;
  if (terminal$.sessionByBindingId[value.bindingId].peek()?.stopping === true) return undefined;
  return { bindingId: value.bindingId, failure: { epoch: value.epoch, code } };
};

/** Mount once: report needs to main, open clicked banners, play their cues. */
export const useDesktopNotifications = (): void => {
  const report = useNotifyReport();
  const key = report ? reportKey(report) : "";

  useEffect(() => {
    if (!report) return;
    void getJuntoApi()?.notificationsReport?.(report).catch(() => undefined);
    // The key is the report's content; a new object with the same content is no news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const api = getJuntoApi();
    const offActivate = api?.onNotificationActivate?.(openNotifyTarget);
    const offCue = api?.onNotificationCue?.(({ cue }) => playNotificationCue(cue));
    const offPreamble = api?.onPreamble?.((event: PreambleEvent) => {
      const own = (event.provenance ?? "agent") === "agent" && (event.action ?? "say") === "say";
      if (own && event.text.trim()) lastSaid$.set({ ...lastSaid$.peek(), [event.nodeId]: event.text.trim() });
    });
    // Unkeyed: exits arrive for seats whose surface is closed, which is most of them.
    const offTerminal = onTerminalEvent((event) => {
      const seen = failureOf(event);
      if (!seen) return;
      const current = seatFailures$.peek();
      if (seen.failure) seatFailures$.set({ ...current, [seen.bindingId]: seen.failure });
      else if (current[seen.bindingId]) {
        const { [seen.bindingId]: _cleared, ...rest } = current;
        seatFailures$.set(rest);
      }
    });
    return () => {
      offActivate?.();
      offCue?.();
      offPreamble?.();
      offTerminal();
    };
  }, []);
};

/** Renders nothing; keeps desktop notifications in step with the canvas. */
export function DesktopNotificationsHost(): null {
  useDesktopNotifications();
  return null;
}
