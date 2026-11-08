/**
 * Desktop notifications in main: the plane, made once at boot with
 * Electron's notification, badge and dock, and main's handlers of the
 * window's notifications group (src/contract/window/notifications.ts). What
 * the plane tells a window (a click, a cue) goes to every window that follows
 * the group's event stream; only trusted windows get a link.
 */
import { Notification, app, shell, type BrowserWindow } from "electron";
import { Context, Effect, Queue, Stream } from "effect";
import { CompanionCore } from "../../contract/core/companion";
import { NotificationsWindowRpcs, type NotifyWindowEvent } from "../../contract/window/notifications";
import { createNotificationPlane, type NotificationPlane } from "./plane";

/** System Settings, Notifications, with Junto selected. */
export const MAC_NOTIFICATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.skastr0.junto";

/** The plane, and what it tells the windows: each listener hears every click and cue from now on. */
export type MainNotifications = NotificationPlane & {
  readonly told: (listener: (event: NotifyWindowEvent) => void) => () => void;
};

/**
 * Make the plane. `window` is the trusted Command Center window, re-read on
 * every use; `enabled` is false where banners must never appear.
 */
export const makeMainNotifications = (options: {
  readonly window: () => BrowserWindow | undefined;
  readonly enabled: boolean;
}): MainNotifications => {
  const listeners = new Set<(event: NotifyWindowEvent) => void>();
  const tell = (event: NotifyWindowEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const plane = createNotificationPlane({
    window: options.window,
    enabled: options.enabled,
    supported: () => Notification.isSupported(),
    create: (notification) => new Notification(notification),
    setBadge: (count) => {
      app.setBadgeCount(count);
    },
    bounce: () => {
      app.dock?.bounce("informational");
    },
    focusApp: () => {
      if (process.platform === "darwin") app.focus({ steal: true });
    },
    activate: (target) => tell({ _tag: "Activate", target }),
    cue: (cue) => tell({ _tag: "Cue", cue }),
  });
  return {
    ...plane,
    told: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** Main's desktop notifications, for the window's handlers. */
export class MainNotificationsService extends Context.Service<MainNotificationsService, MainNotifications>()(
  "@junto/app/MainNotifications",
) {}

export const NotificationsWindowHandlers = NotificationsWindowRpcs.toLayer(
  Effect.gen(function* () {
    const notifications = yield* MainNotificationsService;
    const companion = yield* CompanionCore;
    return {
      NotificationsReport: ({ report }) =>
        Effect.gen(function* () {
          notifications.report(report);
          // The phone companion reads the desktop's open canvas and its rings
          // where it runs, in the core (`companion/backend.ts`): main says
          // what the window said. A report the core missed costs the phone a
          // guess, never the window's notifications, so the call still answers.
          yield* companion.CompanionDesktopReport({ report }).pipe(
            Effect.catchCause((cause) => Effect.sync(() => console.error("[companion] the desktop report did not reach the core:", cause))),
          );
        }),
      NotificationsTest: () => Effect.promise(() => notifications.test()),
      NotificationsDelivery: () => Effect.sync(() => notifications.delivery()),
      // A fixed system URL, never one the window supplies.
      NotificationsOpenSystemSettings: () =>
        process.platform === "darwin"
          ? Effect.promise(() => shell.openExternal(MAC_NOTIFICATION_SETTINGS_URL)).pipe(Effect.as(true))
          : Effect.succeed(false),
      NotificationsEvents: () =>
        Stream.callback<NotifyWindowEvent>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => notifications.told((event) => Queue.offerUnsafe(queue, event))),
            (off) => Effect.sync(off),
          ),
        ),
    };
  }),
);
