import type { BrowserWindow } from "electron";
import {
  badgeCount,
  emptyNotifyState,
  flush,
  nextFlushAt,
  observe,
  setAway,
  type NotifyCue,
  type NotifyPost,
  type NotifyReport,
  type NotifyState,
  type NotifyTarget,
} from "@shared/desktop-notifications";
import { PRODUCT_NAME } from "@shared/product-name";
import { defaultNotifications, type NotificationSettings } from "@shared/settings";

/**
 * Desktop notifications, the Electron side. The renderer reports the open
 * needs; this plane knows whether the Junto window is in front, runs the
 * shared policy, shows native banners (silent: the renderer plays the cue),
 * keeps the Dock badge on the feed's count, and routes a click back to the
 * seat or the feed.
 *
 * Electron seams are injected so the plane runs under test without a display.
 */

/** The slice of Electron's Notification the plane uses. */
export interface NativeNotification {
  show(): void;
  close(): void;
  on(event: "click" | "close" | "show", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
}

/**
 * Whether macOS delivers Junto's banners, as last seen: a banner shown means
 * allowed, a refusal means blocked (the operator turned Junto off, or the
 * build is unsigned), nothing yet means unknown.
 */
export type NotificationDelivery =
  | { readonly state: "unknown" | "allowed" }
  | { readonly state: "blocked"; readonly reason: string };

export type NotificationPlaneDeps = {
  readonly window: () => BrowserWindow | undefined;
  /** False where banners must never appear (E2E, headless). */
  readonly enabled: boolean;
  readonly supported: () => boolean;
  readonly create: (options: {
    /** Stable per seat: macOS replaces a delivered banner with the same id. */
    readonly id: string;
    /** Notification Center groups a canvas's banners together. */
    readonly groupId: string;
    readonly title: string;
    readonly subtitle?: string;
    readonly body: string;
    readonly silent: true;
  }) => NativeNotification;
  readonly setBadge: (count: number) => void;
  readonly bounce: () => void;
  /** Bring the app to the front (macOS: take focus from the other app). */
  readonly focusApp: () => void;
  readonly activate: (target: NotifyTarget) => void;
  readonly cue: (cue: NotifyCue) => void;
  readonly now?: () => number;
};

export type NotificationPlane = {
  readonly report: (report: NotifyReport) => void;
  /**
   * A banner on demand, from Settings: also where macOS asks permission.
   * Settles when macOS shows or refuses it, or after a wait.
   */
  readonly test: () => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly delivery: () => NotificationDelivery;
  /** Follow this window's focus, visibility, and minimise. */
  readonly attach: (window: BrowserWindow) => () => void;
  readonly dispose: () => void;
};

type Delivered = { readonly notification: NativeNotification; readonly keys: Set<string> };

/** How long a test waits for macOS to show or refuse it (a first-time prompt included). */
const TEST_ANSWER_MS = 8_000;
export const BLOCKED_MESSAGE = "macOS is not showing Junto's notifications. Allow them in System Settings, Notifications, Junto.";

/** In front means visible, not minimised, and focused; anything else is away. */
export const windowAway = (window: BrowserWindow | undefined): boolean => {
  if (window === undefined || window.isDestroyed()) return true;
  return !window.isVisible() || window.isMinimized() || !window.isFocused();
};

export const createNotificationPlane = (deps: NotificationPlaneDeps): NotificationPlane => {
  const now = deps.now ?? Date.now;
  let state: NotifyState = emptyNotifyState();
  let prefs: NotificationSettings = defaultNotifications();
  let badge = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const delivered = new Map<string, Delivered>();
  let delivery: NotificationDelivery = { state: "unknown" };

  const syncAway = (): void => {
    state = setAway(state, windowAway(deps.window()));
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    const at = nextFlushAt(state);
    if (at === null) return;
    timer = setTimeout(runFlush, Math.max(0, at - now()));
  };

  const activate = (target: NotifyTarget): void => {
    const window = deps.window();
    if (window !== undefined && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    deps.focusApp();
    deps.activate(target);
  };

  const show = (
    post: Pick<NotifyPost, "tag" | "title" | "subtitle" | "body" | "target" | "keys">,
  ): NativeNotification => {
    delivered.get(post.tag)?.notification.close();
    const notification = deps.create({
      id: `junto:${post.tag}`,
      groupId: `junto:${post.target.canvasName}`,
      title: post.title,
      ...(post.subtitle === undefined ? {} : { subtitle: post.subtitle }),
      body: post.body,
      silent: true,
    });
    // Electron drops click events for a Notification nobody holds, so the
    // map is also what keeps each delivered banner alive.
    const entry: Delivered = { notification, keys: new Set(post.keys) };
    notification.on("click", () => {
      if (delivered.get(post.tag) === entry) delivered.delete(post.tag);
      activate(post.target);
    });
    notification.on("close", () => {
      if (delivered.get(post.tag) === entry) delivered.delete(post.tag);
    });
    notification.on("show", () => {
      delivery = { state: "allowed" };
    });
    notification.on("failed", (_event, error) => {
      if (delivered.get(post.tag) === entry) delivered.delete(post.tag);
      delivery = { state: "blocked", reason: String(error) };
    });
    delivered.set(post.tag, entry);
    notification.show();
    return notification;
  };

  function runFlush(): void {
    timer = undefined;
    if (disposed) return;
    syncAway();
    const result = flush(state, now(), prefs);
    state = result.state;
    if (deps.enabled && deps.supported()) {
      for (const post of result.posts) {
        show(post);
        deps.cue(post.cue);
        if (post.bounce) deps.bounce();
      }
    }
    schedule();
  }

  const closeResolved = (resolved: ReadonlyArray<string>): void => {
    if (resolved.length === 0) return;
    for (const [tag, entry] of delivered) {
      for (const key of resolved) entry.keys.delete(key);
      if (entry.keys.size > 0) continue;
      delivered.delete(tag);
      entry.notification.close();
    }
  };

  const setBadge = (count: number): void => {
    if (count === badge) return;
    badge = count;
    if (deps.enabled) deps.setBadge(count);
  };

  return {
    report: (report) => {
      if (disposed) return;
      prefs = report.prefs;
      setBadge(badgeCount(report));
      syncAway();
      const observed = observe(state, report.subjects, now());
      state = observed.state;
      closeResolved(observed.resolved);
      schedule();
    },
    test: async () => {
      if (!deps.enabled) return { ok: false, message: "Notifications are off in this run." };
      if (!deps.supported()) return { ok: false, message: "This system has no desktop notifications." };
      const notification = show({
        tag: "test",
        title: PRODUCT_NAME,
        body: "Notifications are on. When an agent needs you and Junto is in the background, it shows up here.",
        target: { kind: "feed", canvasName: "" },
        keys: [],
      });
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: true, message: "Sent. If macOS asked, allow Junto; if nothing appeared, check System Settings, Notifications." }),
          TEST_ANSWER_MS,
        );
        notification.on("show", () => {
          clearTimeout(timer);
          resolve({ ok: true, message: "Sent." });
        });
        notification.on("failed", () => {
          clearTimeout(timer);
          resolve({ ok: false, message: BLOCKED_MESSAGE });
        });
      });
    },
    delivery: () => delivery,
    attach: (window) => {
      const onChange = (): void => {
        syncAway();
        schedule();
      };
      const events = ["focus", "blur", "show", "hide", "minimize", "restore"] as const;
      for (const event of events) window.on(event as "focus", onChange);
      onChange();
      return () => {
        if (window.isDestroyed()) return;
        for (const event of events) window.removeListener(event as "focus", onChange);
      };
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      delivered.clear();
    },
  };
};
