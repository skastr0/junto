// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { use$ } from "@legendapp/state/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { CompanionDeviceRecord } from "../src/shared/companion-devices";
import { buildOperatorFeed, type OperatorFeed as Feed } from "../src/shared/operator-feed";
import { OperatorFeed } from "../src/renderer/components/feed/OperatorFeed";
import { subjectsFromFeed } from "../src/renderer/lib/desktop-notify";
import {
  phoneReach$,
  phoneReachSection,
  REMOTE_LOGIN_ITEM_ID,
  startPhoneReachWatch,
  withPhoneReach,
} from "../src/renderer/lib/phone-reach";
import { state$ } from "../src/renderer/lib/state";

// The real feed, fed by hand, with this Mac's item folded in the way
// useOperatorFeed folds it.
const live = vi.hoisted(() => {
  let feed: Feed | undefined;
  const listeners = new Set<() => void>();
  return {
    set: (next: Feed): void => {
      feed = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: (): Feed => feed!,
  };
});

vi.mock("../src/renderer/lib/operator-feed", async (importOriginal) => {
  const { phoneReach$: reach$, withPhoneReach: fold } = await import("../src/renderer/lib/phone-reach");
  return {
    ...(await importOriginal<typeof import("../src/renderer/lib/operator-feed")>()),
    useOperatorFeed: (): Feed => {
      const feed = useSyncExternalStore(live.subscribe, live.read);
      const paired = use$(reach$.paired);
      const remoteLogin = use$(reach$.remoteLogin);
      return fold({ ...feed, sections: feed.sections.map((section) => ({ ...section, items: [...section.items] })) }, { paired, remoteLogin });
    },
  };
});

const CANVAS = "phone-reach";
const NOW = 10_000_000;
const TEXT = "Remote Login is off, so your phone cannot reach this Mac.";

const feedOf = (ids: ReadonlyArray<string>): Feed =>
  buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: NOW,
    seats: [{ seat: { nodeId: "seat-build", name: "build", portraitIdentity: "build" }, region: { regionId: "build", label: "Build", path: ["Build"] } }],
    signals: ids.map(
      (id, index): AgentSignal => ({
        signalId: id,
        canvasName: CANVAS,
        nodeId: "seat-build",
        kind: "feedback",
        text: `${id} is ready`,
        createdAt: NOW - (100 - index) * 60_000,
        state: "open",
      }),
    ),
  });

const phone = (state: CompanionDeviceRecord["state"]): CompanionDeviceRecord => ({
  deviceId: "dev_01M596MKF33K3KBPFC9C8V3F20",
  name: "Phone",
  state,
  createdAt: NOW,
});

beforeEach(() => {
  phoneReach$.set({ paired: false, remoteLogin: undefined });
});

describe("this Mac's item", () => {
  it("is there only while a paired phone cannot reach this Mac", () => {
    expect(phoneReachSection({ paired: false, remoteLogin: "off" }, CANVAS)).toBeUndefined();
    expect(phoneReachSection({ paired: true, remoteLogin: undefined }, CANVAS)).toBeUndefined();
    expect(phoneReachSection({ paired: true, remoteLogin: "on" }, CANVAS)).toBeUndefined();
    const section = phoneReachSection({ paired: true, remoteLogin: "off" }, CANVAS)!;
    expect(section.region.label).toBe("This Mac");
    expect(section.items.map((item) => [item.itemId, item.kind, item.text, item.since])).toEqual([
      [REMOTE_LOGIN_ITEM_ID, "attention", TEXT, undefined],
    ]);
  });

  it("is counted with the rest of the feed, and never pings", () => {
    const feed = feedOf(["a", "b"]);
    expect(withPhoneReach(feed, { paired: false, remoteLogin: "off" })).toBe(feed);
    const folded = withPhoneReach(feed, { paired: true, remoteLogin: "off" });
    expect(folded.count).toBe(3);
    expect(folded.sections.map((section) => section.region.label)).toEqual(["Build", "This Mac"]);
    expect(subjectsFromFeed(folded).map((subject) => subject.key)).toEqual(subjectsFromFeed(feed).map((subject) => subject.key));
  });
});

describe("the watch", () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  };
  const settle = () => new Promise((done) => setTimeout(done, 0));

  const harness = (devices: ReadonlyArray<CompanionDeviceRecord>) => {
    const asks: Array<ReturnType<typeof deferred<"on" | "off">>> = [];
    let push: (next: ReadonlyArray<CompanionDeviceRecord>) => void = () => undefined;
    const focus = new EventTarget();
    const stop = startPhoneReachWatch(
      {
        companionDevices: async () => devices,
        onCompanionDevicesChanged: (listener) => {
          push = listener;
          return () => undefined;
        },
        companionRemoteLogin: () => {
          const ask = deferred<"on" | "off">();
          asks.push(ask);
          return ask.promise;
        },
      },
      focus as unknown as Window,
    );
    return { asks, push: (next: ReadonlyArray<CompanionDeviceRecord>) => push(next), focus: () => focus.dispatchEvent(new Event("focus")), stop };
  };

  it("never asks with no phone paired, not even on focus", async () => {
    const watch = harness([phone("pairing")]);
    await settle();
    watch.focus();
    await settle();
    expect(watch.asks).toHaveLength(0);
    expect(phoneReach$.peek()).toEqual({ paired: false, remoteLogin: undefined });
    watch.stop();
  });

  it("asks once a phone is paired, again on focus, and closes the item once sshd listens", async () => {
    const watch = harness([phone("paired")]);
    await settle();
    expect(watch.asks).toHaveLength(1);
    watch.asks[0]!.resolve("off");
    await settle();
    expect(phoneReach$.peek()).toEqual({ paired: true, remoteLogin: "off" });

    // While it asks again, the last answer holds: the item does not blink.
    watch.focus();
    expect(watch.asks).toHaveLength(2);
    expect(phoneReach$.remoteLogin.peek()).toBe("off");
    watch.asks[1]!.resolve("on");
    await settle();
    expect(phoneReach$.remoteLogin.peek()).toBe("on");
    watch.stop();
  });

  it("keeps only the latest answer, and forgets it when the last phone leaves", async () => {
    const watch = harness([phone("paired")]);
    await settle();
    watch.focus();
    watch.asks[1]!.resolve("on");
    watch.asks[0]!.resolve("off");
    await settle();
    expect(phoneReach$.remoteLogin.peek()).toBe("on");

    watch.push([]);
    expect(phoneReach$.peek()).toEqual({ paired: false, remoteLogin: undefined });
    watch.push([phone("paired")]);
    expect(watch.asks).toHaveLength(3);
    watch.stop();
  });
});

describe("in the open feed", () => {
  let root: Root;
  let host: HTMLDivElement;
  const oldCanvas = state$.canvasName.peek();
  const openSettings = vi.fn(async () => ({ ok: true }));
  const reveal = vi.fn();

  const cards = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>("[data-testid='operator-feed-card']")];
  const cardOf = (itemId: string): HTMLElement | null => document.body.querySelector(`[data-item-id='${itemId}']`);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("junto", { companionOpenRemoteLoginSettings: openSettings });
    HTMLElement.prototype.scrollIntoView = reveal;
    state$.canvasName.set(CANVAS);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    state$.canvasName.set(oldCanvas);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    openSettings.mockClear();
    reveal.mockClear();
  });

  it("arrives and leaves without moving or remounting a card, and opens Remote Login settings", async () => {
    live.set(feedOf(["a", "b", "c"]));
    await act(async () => root.render(<OperatorFeed />));
    const before = cards();
    expect(before.map((card) => card.dataset.itemId)).toEqual(["signal:a", "signal:b", "signal:c"]);
    const scroll = document.body.querySelector<HTMLElement>("[data-testid='operator-feed']")!;
    scroll.scrollTop = 120;

    await act(async () => phoneReach$.set({ paired: true, remoteLogin: "off" }));
    const mac = cardOf(REMOTE_LOGIN_ITEM_ID)!;
    expect(mac.textContent).toContain(TEXT);
    expect(cards().filter((card) => card !== mac)).toEqual(before);

    // Actions belong to the selected item, in the detail pane: select it first.
    await act(async () => mac.click());
    const pane = document.body.querySelector<HTMLElement>("[data-testid='operator-feed-detail']")!;
    expect(pane.dataset.itemId).toBe(REMOTE_LOGIN_ITEM_ID);
    const open = [...pane.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Open Remote Login settings"),
    )!;
    await act(async () => open.click());
    expect(openSettings).toHaveBeenCalledTimes(1);

    // Back from System Settings with Remote Login on: it fades out in place.
    await act(async () => phoneReach$.remoteLogin.set("on"));
    expect(cardOf(REMOTE_LOGIN_ITEM_ID)).toBe(mac);
    expect(mac.parentElement!.classList.contains("operator-feed__slot--leaving")).toBe(true);
    await act(async () => vi.advanceTimersByTime(300));
    expect(cardOf(REMOTE_LOGIN_ITEM_ID)).toBeNull();
    expect(cards()).toEqual(before);

    expect(reveal).not.toHaveBeenCalled();
    expect(scroll.scrollTop).toBe(120);
  });
});
