/**
 * The page chrome's pure parts: what typed text in the address bar means, how
 * the driver mark reads, and which takeover control to offer.
 */
import { classifyBrowserTarget, describeBrowserTargetRejection } from "@shared/browser-policy";
import type { BrowserChromeRefusal } from "@shared/browser-chrome";
import { driverMark, type DriverMark, type PageDriving } from "@shared/page-driver";

export type AddressTarget =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly message: string };

/**
 * What the address bar sends: typed text with no scheme is https, anything
 * else is judged by the same policy main applies, so the bar refuses what
 * main would and says why in the policy's own words.
 */
export const addressTarget = (typed: string): AddressTarget => {
  const text = typed.trim();
  if (text === "") return { ok: false, message: "Type an address." };
  // A scheme, but not `host:port`: `localhost:3000` is an address with no scheme, not a "localhost:" one.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(text);
  const withScheme = hasScheme ? text : `https://${text}`;
  const decision = classifyBrowserTarget(withScheme);
  return decision.allowed
    ? { ok: true, url: decision.normalizedUrl }
    : { ok: false, message: describeBrowserTargetRejection(decision.reason) };
};

export type DriverView = {
  /** The mark's kind, for styling and tests. */
  readonly kind: DriverMark["kind"];
  /** One short sentence, said the same way everywhere the page is shown. */
  readonly text: string;
  /** A seat is acting right now: the mark moves. */
  readonly live: boolean;
};

/** The mark as words. A seat's name is resolved by the caller. */
export const driverView = (
  driving: PageDriving,
  now: number,
  seatName: (nodeId: string) => string | undefined,
): DriverView => {
  const mark = driverMark(driving, now);
  switch (mark.kind) {
    case "idle":
      return { kind: "idle", text: "Nobody is driving", live: false };
    case "operator":
      return { kind: "operator", text: "You are driving", live: false };
    case "operator-held":
      return { kind: "operator-held", text: "You hold this page. Seats are paused.", live: false };
    case "seat": {
      const name = seatName(mark.nodeId) ?? mark.nodeId;
      return { kind: "seat", text: mark.running ? `${name} is driving` : `${name} drove last`, live: mark.running };
    }
  }
};

export type TakeoverOffer =
  | { readonly action: "take-over"; readonly label: string }
  | { readonly action: "release"; readonly label: string };

/** One control: take over while seats may act, hand back while the operator holds. */
export const takeoverOffer = (driving: PageDriving): TakeoverOffer =>
  driving.control.kind === "operator-held"
    ? { action: "release", label: "Hand back" }
    : { action: "take-over", label: "Take over" };

/** A tab's label: its title, else its host, else a blank page. */
export const tabLabel = (tab: { readonly title: string; readonly url: string }): string => {
  if (tab.title.trim() !== "") return tab.title.trim();
  try {
    return new URL(tab.url).host || "New tab";
  } catch {
    return "New tab";
  }
};

/** A refusal as one line the chrome can show. Exhaustive over the contract's kinds. */
export const refusalLine = (refusal: BrowserChromeRefusal): string => {
  switch (refusal.kind) {
    case "no_such_tab":
      return "That tab is already closed.";
    case "last_tab":
      return "A page keeps at least one tab.";
    case "too_many_tabs":
      return `A page holds at most ${refusal.limit} tabs.`;
    case "bad_index":
      return "That tab cannot move there.";
    case "operator_holds":
      return "You hold this page, so seats are paused.";
    case "invalid":
      return refusal.message;
    case "not_found":
      return "This page is not open any more.";
  }
};

/**
 * Whether a refused box post says its staged shot is spent (main's words:
 * "That shot was already posted or dropped: draw the box again."). Only then
 * is the shot gone; any other refusal leaves it staged for a retry.
 */
export const boxShotSpent = (refusal: BrowserChromeRefusal): boolean =>
  refusal.kind === "invalid" && /already posted or dropped/i.test(refusal.message);
