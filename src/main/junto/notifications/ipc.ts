import { Notification, app, ipcMain, shell, type BrowserWindow } from "electron";
import { Schema } from "effect";
import {
  NOTIFY_CATEGORIES,
  type NotifyCategory,
  type NotifyReport,
  type NotifySubject,
} from "@shared/desktop-notifications";
import { IPC_CHANNELS } from "@shared/ipc";
import { NotificationSettings } from "@shared/settings";
import { trustedRendererIpc } from "../trusted-main-webcontents";
import { createNotificationPlane, type NotificationPlane } from "./plane";
import { noteDesktopReport } from "../companion/desktop-report";

const MAX_SUBJECTS = 500;
/** System Settings, Notifications, with Junto selected. */
export const MAC_NOTIFICATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.skastr0.junto";
const MAX_TEXT = 2_000;
const decodePrefs = Schema.decodeUnknownResult(NotificationSettings);

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

const isCategory = (value: unknown): value is NotifyCategory =>
  (NOTIFY_CATEGORIES as ReadonlyArray<unknown>).includes(value);

const decodeSubject = (raw: unknown): NotifySubject | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const key = text(value.key, 512);
  const canvasName = text(value.canvasName, 512);
  const nodeId = text(value.nodeId, 512);
  const seatName = text(value.seatName, 512);
  const body = text(value.text);
  if (!key || canvasName === undefined || !nodeId || seatName === undefined || body === undefined) return undefined;
  if (!isCategory(value.category)) return undefined;
  return { key, category: value.category, canvasName, nodeId, seatName, text: body };
};

/** The renderer's report, or undefined when it is not one. */
export const decodeNotifyReport = (raw: unknown): NotifyReport | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const canvasName = text(value.canvasName, 512);
  if (canvasName === undefined || !Array.isArray(value.subjects) || value.subjects.length > MAX_SUBJECTS) {
    return undefined;
  }
  const subjects = value.subjects.map(decodeSubject);
  if (subjects.some((subject) => subject === undefined)) return undefined;
  if (typeof value.badge !== "number" || !Number.isFinite(value.badge)) return undefined;
  const prefs = decodePrefs(value.prefs);
  if (prefs._tag === "Failure") return undefined;
  return {
    canvasName,
    subjects: subjects as ReadonlyArray<NotifySubject>,
    badge: value.badge,
    prefs: prefs.success,
  };
};

/**
 * Register the notification channels and return the plane. `window` is the
 * trusted Command Center window, re-read on every use.
 */
export const registerNotificationIpc = (options: {
  readonly window: () => BrowserWindow | undefined;
  readonly enabled: boolean;
}): NotificationPlane => {
  const send = (channel: string, payload: unknown): void => {
    const window = options.window();
    if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
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
    activate: (target) => send(IPC_CHANNELS.notificationActivate, target),
    cue: (cue) => send(IPC_CHANNELS.notificationCue, { cue }),
  });

  const privilegedIpc = trustedRendererIpc(ipcMain);
  privilegedIpc.handle(IPC_CHANNELS.notificationsReport, (_event, raw: unknown) => {
    const report = decodeNotifyReport(raw);
    if (report === undefined) return { ok: false as const, message: "notification report is invalid" };
    plane.report(report);
    noteDesktopReport(report);
    return { ok: true as const };
  });
  privilegedIpc.handle(IPC_CHANNELS.notificationsTest, () => plane.test());
  privilegedIpc.handle(IPC_CHANNELS.notificationsDelivery, () => plane.delivery());
  // A fixed system URL, never one the renderer supplies.
  privilegedIpc.handle(IPC_CHANNELS.notificationsOpenSystemSettings, async () => {
    if (process.platform !== "darwin") return { ok: false as const };
    await shell.openExternal(MAC_NOTIFICATION_SETTINGS_URL);
    return { ok: true as const };
  });
  return plane;
};
