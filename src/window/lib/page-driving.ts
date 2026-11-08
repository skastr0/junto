/**
 * Whether a seat is driving a page now, for its canvas chip's Working tag
 * (docs/node-card-language.md, Page). Main says a page changed with one
 * event; this reads that page's driving once and keeps one boolean per ref,
 * so a chip reads a single field and no chip subscribes or ticks on its own.
 * A seat that just finished stays Working for the driver mark's recent
 * window, ended by one timer per page, never a clock per chip.
 */
import { observable } from "@legendapp/state";
import type { JuntoBrowserApi } from "@shared/ipc";
import { driverMark, DRIVER_RECENT_MS, type PageDriving } from "@shared/page-driver";
import { browser$, browserSessionIdForRef } from "./browser-state";
import { getJuntoApi } from "./junto-api";

export const pageDriving$ = observable({
  /** canonical junto:// ref -> a seat is driving it now. */
  workingByRef: {} as Record<string, boolean>,
});

type PageApi = Partial<Pick<JuntoBrowserApi, "browserPageState" | "onBrowserPageChanged">>;
const pageApi = (): PageApi | undefined => getJuntoApi() as PageApi | undefined;

const expiries = new Map<string, ReturnType<typeof setTimeout>>();
const reads = new Map<string, number>();

/** Set one page's flag from its driving, and end a finished seat's window with one timer. */
export const applyPageDriving = (ref: string, driving: PageDriving | undefined, now = Date.now()): void => {
  const expiry = expiries.get(ref);
  if (expiry !== undefined) clearTimeout(expiry);
  expiries.delete(ref);
  const mark = driving === undefined ? undefined : driverMark(driving, now);
  const working = mark?.kind === "seat";
  if ((pageDriving$.workingByRef[ref].peek() ?? false) !== working) pageDriving$.workingByRef[ref].set(working);
  if (mark?.kind === "seat" && !mark.running && driving?.last.kind === "seat") {
    // One past the window's end, so an early timer never spins on a zero wait.
    const left = Math.max(0, driving.last.at + DRIVER_RECENT_MS - now) + 1;
    expiries.set(ref, setTimeout(() => applyPageDriving(ref, driving), left));
  }
};

const refOfSession = (sessionId: string): string | undefined =>
  Object.values(browser$.sessionByRef.peek()).find((session) => session?.sessionId === sessionId)?.ref;

/** Read a page's driving from main; a later read for the same page wins. */
export const refreshPageDriving = async (ref: string): Promise<void> => {
  const api = pageApi();
  const sessionId = browserSessionIdForRef(ref);
  // Every outcome is a newer read, so an older one still in flight lands as nothing.
  const read = (reads.get(ref) ?? 0) + 1;
  reads.set(ref, read);
  if (api?.browserPageState === undefined || sessionId === undefined) {
    applyPageDriving(ref, undefined);
    return;
  }
  const result = await api.browserPageState(sessionId).catch(() => undefined);
  if (reads.get(ref) !== read) return;
  applyPageDriving(ref, result?.ok === true ? result.data?.driving : undefined);
};

/** A page's keys go with its session, so a long canvas keeps none for pages gone. */
const forgetPage = (ref: string): void => {
  const expiry = expiries.get(ref);
  if (expiry !== undefined) clearTimeout(expiry);
  expiries.delete(ref);
  reads.delete(ref);
  pageDriving$.workingByRef[ref].delete();
};

let subscribed = false;
/** Page events for a session the renderer has not mapped yet, replayed once it has. */
const unmapped = new Set<string>();
const UNMAPPED_MAX = 64;

/** One listener for every page: main's page-changed event rereads that page alone. */
export const subscribePageDriving = (): void => {
  const api = pageApi();
  if (subscribed || api?.onBrowserPageChanged === undefined) return;
  subscribed = true;
  api.onBrowserPageChanged((sessionId) => {
    const ref = refOfSession(sessionId);
    if (ref === undefined) {
      // Bounded: a session that never maps is not kept forever.
      if (unmapped.size >= UNMAPPED_MAX) unmapped.delete(unmapped.values().next().value!);
      unmapped.add(sessionId);
    }
    else void refreshPageDriving(ref);
  });
  browser$.sessionByRef.onChange(() => {
    const sessions = browser$.sessionByRef.peek();
    for (const sessionId of [...unmapped]) {
      const ref = refOfSession(sessionId);
      if (ref === undefined) continue;
      unmapped.delete(sessionId);
      void refreshPageDriving(ref);
    }
    for (const ref of Object.keys(pageDriving$.workingByRef.peek())) {
      const session = sessions[ref];
      if (session === undefined || session.state === "destroyed") forgetPage(ref);
    }
  });
};
