import { observable } from "@legendapp/state";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import type { JuntoApi } from "@shared/ipc";
import { feedItemRank, type FeedItem, type FeedRegion, type FeedSeat, type FeedSection, type OperatorFeed } from "@shared/operator-feed";
import { getJuntoApi } from "./junto-api";

/**
 * A paired phone reaches this Mac over Remote Login (macOS sshd). While a
 * phone is paired and nothing listens, the Needs you feed carries one item
 * that says so, with the way to switch it on. Main probes the port; this
 * window asks when a phone is paired and whenever it regains focus, and
 * keeps the last answer while it asks again, so the item never blinks.
 *
 * Desktop only: the phone reads the feed main builds for it, and could not
 * reach this Mac to read this one anyway.
 */

export type PhoneReach = {
  /** At least one phone has finished pairing. */
  readonly paired: boolean;
  /** Unknown until main has answered since a phone was paired. */
  readonly remoteLogin: "on" | "off" | undefined;
};

export const phoneReach$ = observable<PhoneReach>({ paired: false, remoteLogin: undefined });

export const REMOTE_LOGIN_ITEM_ID = "mac:remote-login";

/** Never a canvas region or node: those ids carry no colon. */
const THIS_MAC_REGION: FeedRegion = { regionId: "junto:this-mac", label: "This Mac", path: [] };
const THIS_MAC: FeedSeat = { nodeId: "junto:this-mac", name: "This Mac", portraitIdentity: "junto:this-mac" };

/** The item for this Mac, not for a seat: it is fixed in System Settings. */
export const isThisMacItem = (item: Pick<FeedItem, "seat">): boolean => item.seat.nodeId === THIS_MAC.nodeId;

/** The feed's section for this Mac: only a paired phone that cannot reach it. */
export const phoneReachSection = (reach: PhoneReach, canvasName: string): FeedSection | undefined => {
  if (!reach.paired || reach.remoteLogin !== "off") return undefined;
  // No `since`: when Remote Login went off is not known, and none is made up.
  const item: FeedItem = {
    itemId: REMOTE_LOGIN_ITEM_ID,
    kind: "attention",
    urgency: feedItemRank("attention"),
    canvasName,
    seat: THIS_MAC,
    region: THIS_MAC_REGION,
    text: "Remote Login is off, so your phone cannot reach this Mac.",
  };
  return { region: THIS_MAC_REGION, items: [item], worstUrgency: item.urgency };
};

/** The canvas's feed with this Mac's item in it, counted with the rest. */
export const withPhoneReach = (feed: OperatorFeed, reach: PhoneReach): OperatorFeed => {
  const section = phoneReachSection(reach, feed.canvasName);
  return section ? { ...feed, count: feed.count + section.items.length, sections: [...feed.sections, section] } : feed;
};

export const openRemoteLoginSettings = (): void => {
  void getJuntoApi()?.companionOpenRemoteLoginSettings?.();
};

type ReachApi = Pick<JuntoApi, "companionDevices" | "onCompanionDevicesChanged" | "companionRemoteLogin">;

/**
 * Follow the paired phones, and ask whether Remote Login listens when one is
 * paired and whenever the window regains focus. Returns the unsubscribe.
 */
export const startPhoneReachWatch = (
  api: ReachApi,
  focus: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): (() => void) => {
  const { companionDevices, companionRemoteLogin } = api;
  if (!companionDevices || !companionRemoteLogin) return () => undefined;
  let stopped = false;
  // Only the latest ask lands: an answer that comes back late is older news.
  let asked = 0;
  const check = async (): Promise<void> => {
    if (!phoneReach$.paired.peek()) return;
    const ask = ++asked;
    const answer = await companionRemoteLogin().catch(() => undefined);
    if (stopped || ask !== asked || answer === undefined || !phoneReach$.paired.peek()) return;
    phoneReach$.remoteLogin.set(answer);
  };
  const follow = (devices: ReadonlyArray<CompanionDeviceRecord>): void => {
    if (stopped) return;
    const paired = devices.some((device) => device.state === "paired");
    if (paired === phoneReach$.paired.peek()) return;
    // An answer from before the last phone left says nothing about the next one.
    phoneReach$.set({ paired, remoteLogin: undefined });
    void check();
  };
  void companionDevices().then(follow, () => undefined);
  const offDevices = api.onCompanionDevicesChanged?.(follow) ?? (() => undefined);
  const onFocus = (): void => void check();
  focus.addEventListener("focus", onFocus);
  return () => {
    stopped = true;
    offDevices();
    focus.removeEventListener("focus", onFocus);
  };
};
