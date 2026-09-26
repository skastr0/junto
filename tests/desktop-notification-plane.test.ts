import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import type { BrowserWindow } from "electron";
import { URGENT_SETTLE_MS, type NotifySubject } from "../src/shared/desktop-notifications";
import { defaultNotifications } from "../src/shared/settings";
import { decodeNotifyReport } from "../src/main/junto/notifications/ipc";
import { createNotificationPlane, windowAway } from "../src/main/junto/notifications/plane";

type Banner = {
  readonly options: { id: string; groupId: string; title: string; subtitle?: string; body: string; silent: true };
  shown: boolean;
  closed: boolean;
  readonly listeners: Map<string, Array<(...args: never[]) => void>>;
};

/** What macOS would do: show the banner, or refuse it. */
const emit = (banner: Banner | undefined, event: string, ...args: unknown[]): void => {
  for (const listener of banner?.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
};

const fakeWindow = () => {
  const listeners = new Map<string, Set<() => void>>();
  const window = {
    focused: true,
    visible: true,
    minimized: false,
    isDestroyed: () => false,
    isFocused: () => window.focused,
    isVisible: () => window.visible,
    isMinimized: () => window.minimized,
    restore: vi.fn(() => {
      window.minimized = false;
    }),
    show: vi.fn(),
    focus: vi.fn(),
    on: (event: string, listener: () => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    removeListener: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
    emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
  };
  return window;
};

const need = (nodeId: string, category: NotifySubject["category"], text = "wants your input"): NotifySubject => ({
  key: `${category}:${nodeId}`,
  category,
  canvasName: "main",
  nodeId,
  seatName: nodeId,
  text,
});

const setup = (enabled = true) => {
  const window = fakeWindow();
  const banners: Banner[] = [];
  const deps = {
    window: () => window as unknown as BrowserWindow,
    enabled,
    supported: () => true,
    create: (options: Banner["options"]) => {
      const banner: Banner = { options, shown: false, closed: false, listeners: new Map() };
      banners.push(banner);
      return {
        show: () => {
          banner.shown = true;
        },
        close: () => {
          banner.closed = true;
        },
        on: (event: string, listener: (...args: never[]) => void) => {
          banner.listeners.set(event, [...(banner.listeners.get(event) ?? []), listener]);
        },
      };
    },
    setBadge: vi.fn(),
    bounce: vi.fn(),
    focusApp: vi.fn(),
    activate: vi.fn(),
    cue: vi.fn(),
    now: () => Date.now(),
  };
  const plane = createNotificationPlane(deps);
  plane.attach(window as unknown as BrowserWindow);
  const report = (subjects: ReadonlyArray<NotifySubject>, badge = subjects.length, prefs = defaultNotifications()) =>
    plane.report({ canvasName: "main", subjects, badge, prefs });
  return { window, banners, deps, plane, report };
};

describe("desktop notification plane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a window as away when it is unfocused, hidden, or minimised", () => {
    const window = fakeWindow();
    const away = () => windowAway(window as unknown as BrowserWindow);
    expect(away()).toBe(false);
    window.focused = false;
    expect(away()).toBe(true);
    window.focused = true;
    window.minimized = true;
    expect(away()).toBe(true);
    window.minimized = false;
    window.visible = false;
    expect(away()).toBe(true);
    expect(windowAway(undefined)).toBe(true);
  });

  it("shows nothing while the window is in front, but keeps the badge", () => {
    const { banners, deps, report } = setup();
    report([need("maple", "blocked")], 1);
    vi.advanceTimersByTime(URGENT_SETTLE_MS * 4);
    expect(banners).toHaveLength(0);
    expect(deps.setBadge).toHaveBeenLastCalledWith(1);
  });

  it("posts a silent banner with a cue and a bounce for a seat blocked while away", () => {
    const { window, banners, deps, report } = setup();
    report([]);
    window.focused = false;
    window.emit("blur");
    report([need("maple", "blocked", "cannot reach the database")]);
    vi.advanceTimersByTime(URGENT_SETTLE_MS);
    expect(banners).toHaveLength(1);
    expect(banners[0]).toMatchObject({
      options: { title: "maple", subtitle: "Blocked", body: "cannot reach the database", silent: true },
      shown: true,
    });
    expect(deps.cue).toHaveBeenCalledWith("blocked");
    expect(deps.bounce).toHaveBeenCalledTimes(1);
  });

  it("closes a delivered banner once its need is answered, and clears the badge", () => {
    const { window, banners, deps, report } = setup();
    report([]);
    window.focused = false;
    window.emit("blur");
    report([need("maple", "needsYou")]);
    vi.advanceTimersByTime(URGENT_SETTLE_MS);
    report([], 0);
    expect(banners[0]?.closed).toBe(true);
    expect(deps.setBadge).toHaveBeenLastCalledWith(0);
  });

  it("brings the window forward and opens the seat on click", () => {
    const { window, banners, deps, report } = setup();
    report([]);
    window.focused = false;
    window.minimized = true;
    window.emit("minimize");
    report([need("maple", "needsYou")]);
    vi.advanceTimersByTime(URGENT_SETTLE_MS);
    emit(banners[0], "click");
    expect(window.restore).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    expect(deps.focusApp).toHaveBeenCalled();
    expect(deps.activate).toHaveBeenCalledWith({ kind: "seat", canvasName: "main", nodeId: "maple" });
  });

  it("drops what was pending when the operator comes back first", () => {
    const { window, banners, report } = setup();
    report([]);
    window.focused = false;
    window.emit("blur");
    report([need("maple", "needsYou")]);
    window.focused = true;
    window.emit("focus");
    vi.advanceTimersByTime(URGENT_SETTLE_MS * 4);
    expect(banners).toHaveLength(0);
  });

  it("stays silent in a harness run, badge included", async () => {
    const { window, banners, deps, report, plane } = setup(false);
    window.focused = false;
    window.emit("blur");
    report([need("maple", "blocked")]);
    vi.advanceTimersByTime(URGENT_SETTLE_MS * 4);
    expect(banners).toHaveLength(0);
    expect(deps.setBadge).not.toHaveBeenCalled();
    await expect(plane.test()).resolves.toMatchObject({ ok: false });
  });

  it("shows a test banner on demand and settles when macOS shows it", async () => {
    const { banners, plane } = setup();
    const answer = plane.test();
    expect(banners[0]?.options.title).toBe("Junto");
    emit(banners[0], "show");
    await expect(answer).resolves.toEqual({ ok: true, message: "Sent." });
    expect(plane.delivery()).toEqual({ state: "allowed" });
  });

  it("reports macOS refusing banners, from a test or a real post", async () => {
    const { window, banners, plane, report } = setup();
    const answer = plane.test();
    emit(banners[0], "failed", {}, "The operation couldn't be completed. (UNErrorDomain error 1.)");
    await expect(answer).resolves.toMatchObject({ ok: false });
    expect(plane.delivery()).toMatchObject({ state: "blocked" });

    report([]);
    window.focused = false;
    window.emit("blur");
    report([need("maple", "blocked")]);
    vi.advanceTimersByTime(URGENT_SETTLE_MS);
    emit(banners[1], "show");
    expect(plane.delivery()).toEqual({ state: "allowed" });
  });

  it("gives each seat's banner a stable id, grouped by canvas", () => {
    const { window, banners, report } = setup();
    report([]);
    window.focused = false;
    window.emit("blur");
    report([need("maple", "blocked")]);
    vi.advanceTimersByTime(URGENT_SETTLE_MS);
    expect(banners[0]?.options).toMatchObject({ id: "junto:seat:main:maple", groupId: "junto:main" });
  });
});

describe("notification report decode", () => {
  const valid = { canvasName: "main", subjects: [need("maple", "done")], badge: 2, prefs: defaultNotifications() };

  it("admits a well-formed report", () => {
    expect(decodeNotifyReport(valid)).toEqual(valid);
  });

  it("refuses bad categories, missing fields, and bad prefs", () => {
    expect(decodeNotifyReport({ ...valid, subjects: [{ ...need("maple", "done"), category: "loud" }] })).toBeUndefined();
    expect(decodeNotifyReport({ ...valid, subjects: [{ key: "k" }] })).toBeUndefined();
    expect(decodeNotifyReport({ ...valid, prefs: { enabled: "yes" } })).toBeUndefined();
    expect(decodeNotifyReport({ ...valid, badge: Number.NaN })).toBeUndefined();
    expect(decodeNotifyReport(null)).toBeUndefined();
  });
});
