/**
 * What the desktop last told main about the canvas it has open (the
 * notification report): which canvas that is, and which seats finished work
 * nobody has looked at yet. The phone companion reads both, so `active` and
 * the `done_unread` ring state are the desktop's own, not a guess.
 */
import type { NotifyReport } from "@shared/desktop-notifications";

let latest: { readonly canvasName: string; readonly doneNodeIds: ReadonlySet<string> } | undefined;
const listeners = new Set<() => void>();

export const noteDesktopReport = (report: NotifyReport): void => {
  const doneNodeIds = new Set(
    report.subjects
      .filter((subject) => subject.category === "done" && subject.canvasName === report.canvasName)
      .map((subject) => subject.nodeId),
  );
  const changed =
    latest === undefined ||
    latest.canvasName !== report.canvasName ||
    latest.doneNodeIds.size !== doneNodeIds.size ||
    [...doneNodeIds].some((nodeId) => !latest!.doneNodeIds.has(nodeId));
  latest = { canvasName: report.canvasName, doneNodeIds };
  if (changed) for (const listener of listeners) listener();
};

/** The canvas open on the desktop, when it has reported one. */
export const desktopActiveCanvas = (): string | undefined => latest?.canvasName;

/** Done-but-unread, as the desktop's rings show it; known only for its open canvas. */
export const desktopDoneUnread = (canvasName: string, nodeId: string): boolean =>
  latest?.canvasName === canvasName && latest.doneNodeIds.has(nodeId);

export const onDesktopReport = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
