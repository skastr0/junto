import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type {
  NotifyReport,
  NotifySubject,
  NotifyTarget,
} from "@shared/desktop-notifications";
import type { OperatorFeed } from "@shared/operator-feed";
import { notificationSettings } from "@shared/settings";
import type { PreambleEvent } from "@shared/preamble";
import { activateNodeSurface } from "./activate-node-surface";
import { agentSeat$, bindingIdForNode, presentationForSeat } from "./agent-seat-state";
import { getJuntoApi } from "./junto-api";
import { openOperatorFeed, useOperatorFeed } from "./operator-feed";
import { nodeTitle } from "./presentation";
import { playNotificationCue } from "./sound";
import { state$ } from "./state";
import { terminal$ } from "./terminal-state";
import { onTerminalEvent } from "./terminal-events";

/**
 * The renderer's half of desktop notifications: it knows what needs the
 * operator, main knows whether they are looking. Every change to the open
 * needs goes to main as one report (main decides what becomes a banner and
 * keeps the Dock badge); a clicked banner comes back here to open the seat
 * or the feed, and a posted banner's cue plays here, since banners are
 * silent.
 *
 * Three sources, each already shown in the app:
 * - the ⌘I feed (declared signals and proven needs-input), minus the AI's
 *   advisory reading;
 * - seats that finished a turn the operator has not looked at (done);
 * - agent seats whose process ended with a failure exit, until they start
 *   again (stopped).
 */

type Failure = { readonly epoch: string; readonly code: number };

/** Failed agent generations by binding, until that binding starts again. */
export const seatFailures$ = observable<Record<string, Failure | undefined>>({});
/** The agent's own last words per seat (its `junto preamble`), for a finish line. */
const lastSaid$ = observable<Record<string, string | undefined>>({});

const FEED_CATEGORY = {
  blocked: "blocked",
  attention: "needsYou",
  escalate: "needsYou",
  feedback: "needsYou",
} as const;

/** Feed items as subjects. The AI's reading is advisory and never pings. */
export const subjectsFromFeed = (feed: OperatorFeed): ReadonlyArray<NotifySubject> =>
  feed.sections.flatMap((section) =>
    section.items.flatMap((item): ReadonlyArray<NotifySubject> =>
      item.kind === "health"
        ? []
        : [
            {
              key: item.itemId,
              category: FEED_CATEGORY[item.kind],
              canvasName: item.canvasName,
              nodeId: item.seat.nodeId,
              seatName: item.seat.name,
              text: item.text,
            },
          ],
    ),
  );

const isAgent = (node: CanvasNode): boolean =>
  node.type !== "group" && node.ether?.entity?.kind === "agent";

/** Finished-not-read seats and failed seats on the canvas, as subjects. */
export const seatSubjects = (input: {
  readonly canvasName: string;
  readonly doc: CanvasDoc;
  readonly bindingOf: (node: CanvasNode) => string | undefined;
  readonly seatState: (bindingId: string) => { readonly state: string; readonly at: number } | undefined;
  readonly needsLook: (bindingId: string) => boolean;
  readonly failure: (bindingId: string) => Failure | undefined;
  readonly exitMessage: (bindingId: string) => string | undefined;
  readonly lastSaid: (nodeId: string) => string | undefined;
}): ReadonlyArray<NotifySubject> => {
  const out: NotifySubject[] = [];
  for (const node of input.doc.nodes) {
    if (!isAgent(node)) continue;
    const bindingId = input.bindingOf(node);
    if (!bindingId) continue;
    const seat = { canvasName: input.canvasName, nodeId: node.id, seatName: nodeTitle(node) };
    const failure = input.failure(bindingId);
    if (failure) {
      out.push({
        ...seat,
        key: `failed:${node.id}:${failure.epoch}`,
        category: "failed",
        text: input.exitMessage(bindingId) ?? `ended with exit code ${failure.code}`,
      });
      continue;
    }
    const event = input.seatState(bindingId);
    if (!event) continue;
    const presentation = presentationForSeat(event.state as never, input.needsLook(bindingId));
    if (presentation !== "done") continue;
    out.push({
      ...seat,
      key: `done:${node.id}:${event.at}`,
      category: "done",
      text: input.lastSaid(node.id) ?? "finished and is waiting for you to look",
    });
  }
  return out;
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
  const doc = use$(state$.doc);
  const settings = use$(state$.settings);
  const settingsReady = use$(state$.settingsReady);
  const feed = useOperatorFeed();
  use$(agentSeat$.rev);
  const needsLook = use$(agentSeat$.needsLookByBindingId);
  const failures = use$(seatFailures$);
  const lastSaid = use$(lastSaid$);
  const sessions = use$(terminal$.sessionByBindingId);
  if (!canvasName || !settingsReady) return null;
  const seats = seatSubjects({
    canvasName,
    doc,
    bindingOf: bindingIdForNode,
    seatState: (bindingId) => agentSeat$.byBindingId[bindingId].peek(),
    needsLook: (bindingId) => needsLook[bindingId] === true,
    failure: (bindingId) => failures[bindingId],
    exitMessage: (bindingId) => sessions[bindingId]?.exitMessage?.trim() || undefined,
    lastSaid: (nodeId) => lastSaid[nodeId],
  });
  // A seat both in the feed and finished or stopped posts once: the policy
  // keeps each seat's most urgent need.
  return {
    canvasName,
    subjects: [...subjectsFromFeed(feed), ...seats],
    badge: feed.count,
    prefs: notificationSettings(settings),
  };
};

/** Open what a clicked banner points at: the seat's focus view, else the feed. */
export const openNotifyTarget = (target: NotifyTarget): void => {
  if (!target.canvasName) return;
  if (target.kind === "seat" && target.canvasName === state$.canvasName.peek()) {
    const node = state$.doc.peek().nodes.find((candidate) => candidate.id === target.nodeId);
    if (node && activateNodeSurface(node).opened) return;
  }
  openOperatorFeed();
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
