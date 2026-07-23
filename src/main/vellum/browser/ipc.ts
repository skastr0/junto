import type {
  IpcMain,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  WebContents,
} from "electron";
import { Effect } from "effect";
import {
  IPC_CHANNELS,
  type BrowserOpenInput,
  type BrowserProfileWipeInput,
} from "@shared/ipc";
import { isValidProfileId } from "@shared/browser";
import {
  BROWSER_MAX_REF_BYTES,
  isUtf8WithinLimit,
  parseBrowserSessionId,
  parseBrowserSurfaceBounds,
} from "@shared/browser-limits";
import type { BrowserSessionService } from "./sessions";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { SettingsService } from "../settings/service";
import { makePageTargetResolver, type PageTargetResolver } from "./page-target";

export const resolveBrowserPageTarget: PageTargetResolver = (ref) =>
  AppRuntime.runPromise(
    Effect.flatMap(CanvasesService, (canvases) =>
      Effect.promise(() => makePageTargetResolver(canvases)(ref)),
    ),
  );

const invalidArguments = (message = "unexpected arguments") => ({
  ok: false as const,
  code: "invalid" as const,
  message,
});

const browserUiShuttingDown = () => ({
  ok: false as const,
  code: "cancelled" as const,
  message: "browser UI is shutting down",
});

const isBrowserOpenInput = (input: unknown): input is BrowserOpenInput =>
  typeof input === "object" &&
  input !== null &&
  "ref" in input &&
  Object.keys(input).join(",") === "ref" &&
  typeof input.ref === "string" &&
  input.ref.length > 0 &&
  isUtf8WithinLimit(input.ref, BROWSER_MAX_REF_BYTES);

const isBrowserProfileWipeInput = (input: unknown): input is BrowserProfileWipeInput =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Object.keys(input).sort().join(",") === "confirmation,profileId" &&
  "profileId" in input &&
  "confirmation" in input &&
  typeof input.profileId === "string" &&
  typeof input.confirmation === "string" &&
  isValidProfileId(input.profileId) &&
  input.confirmation === input.profileId;

export type BrowserProfileWipeConfirmation = (
  event: IpcMainInvokeEvent,
  profileId: string,
) => Promise<boolean>;

export const browserProfileWipeDialogOptions = (
  profileId: string,
): MessageBoxOptions => ({
  type: "warning",
  title: "Wipe browser profile",
  message: `Wipe browser profile “${profileId}”?`,
  detail: "This permanently removes cookies, logins, site storage, and live pages in this profile.",
  buttons: ["Cancel", `Wipe ${profileId}`],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

/** Main-owned user-presence gate; renderer text confirmation is UX only. */
export const confirmBrowserProfileWipe: BrowserProfileWipeConfirmation = async (
  event,
  profileId,
) => {
  try {
    const { BrowserWindow, dialog } = await import("electron");
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = browserProfileWipeDialogOptions(profileId);
    const decision = parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options);
    return decision.response === 1;
  } catch {
    return false;
  }
};

export const registerBrowserIpc = (
  ipcMain: IpcMain,
  browserSessions: BrowserSessionService,
  webContentsGetter: () => Iterable<WebContents>,
  pageTargetResolver: PageTargetResolver = resolveBrowserPageTarget,
  profileWipeConfirmation: BrowserProfileWipeConfirmation = confirmBrowserProfileWipe,
): void => {
  // Settings.browser is the sole durable SoT for pool limits. Installation is
  // intentionally delayed until cold profile recovery admits browser IPC.
  browserSessions.setPoolLimitsProvider(() =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const doc = yield* settings.get;
        return {
          maxVisibleSurfaces: doc.browser.maxVisibleSurfaces,
          maxWarmSessions: doc.browser.maxWarmSessions,
        };
      }),
    ),
  );
  browserSessions.setSink((session) => {
    for (const contents of webContentsGetter()) {
      contents.send(IPC_CHANNELS.browserSessionChanged, session);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserProfiles, (_e, ...args: ReadonlyArray<unknown>) =>
    args.length === 0 ? browserSessions.listProfiles() : invalidArguments(),
  );

  ipcMain.handle(IPC_CHANNELS.browserSurfaceConfig, (_e, ...args: ReadonlyArray<unknown>) =>
    args.length === 0 ? browserSessions.surfaceConfig() : invalidArguments(),
  );

  ipcMain.handle(IPC_CHANNELS.browserOpen, async (_e, ...args: ReadonlyArray<unknown>) => {
    if (args.length !== 1) return invalidArguments();
    const input = args[0];
    if (!isBrowserOpenInput(input)) {
      return invalidArguments("canonical bounded page ref required");
    }
    const admission = browserSessions.uiAdmissionSnapshot();
    if (admission === undefined) return browserUiShuttingDown();
    const target = await browserSessions.retainUiIngress(
      "page-resolve",
      pageTargetResolver(input.ref),
    );
    if (!browserSessions.isUiAdmissionCurrent(admission)) {
      return browserUiShuttingDown();
    }
    return target.ok
      ? browserSessions.open(
          target.data,
          undefined,
          () => pageTargetResolver(input.ref),
        )
      : target;
  });

  ipcMain.handle(IPC_CHANNELS.browserClose, (_e, ...args: ReadonlyArray<unknown>) => {
    if (args.length !== 1) return invalidArguments();
    const parsed = parseBrowserSessionId(args[0]);
    return parsed.ok ? browserSessions.close(parsed.value) : parsed;
  });

  ipcMain.handle(IPC_CHANNELS.browserStop, (_e, ...args: ReadonlyArray<unknown>) => {
    if (args.length !== 1) return invalidArguments();
    const parsed = parseBrowserSessionId(args[0]);
    return parsed.ok ? browserSessions.stop(parsed.value) : parsed;
  });

  ipcMain.handle(IPC_CHANNELS.browserWipeProfile, async (event, ...args: ReadonlyArray<unknown>) => {
    if (args.length !== 1 || !isBrowserProfileWipeInput(args[0])) {
      return invalidArguments("exact profile confirmation required");
    }
    const admission = browserSessions.uiAdmissionSnapshot();
    if (admission === undefined) return browserUiShuttingDown();
    const profileId = args[0].profileId;
    const confirmed = await browserSessions.retainUiIngress(
      "profile-wipe-confirmation",
      profileWipeConfirmation(event, profileId),
    ).catch(() => false);
    if (!browserSessions.isUiAdmissionCurrent(admission)) {
      return browserUiShuttingDown();
    }
    return confirmed
      ? browserSessions.wipeProfile(profileId)
      : {
          ok: false as const,
          code: "cancelled" as const,
          message: "browser profile wipe cancelled",
        };
  });

  ipcMain.handle(IPC_CHANNELS.browserSessionState, (_e, ...args: ReadonlyArray<unknown>) => {
    if (args.length !== 1) return invalidArguments();
    const parsed = parseBrowserSessionId(args[0]);
    return parsed.ok ? browserSessions.state(parsed.value) : parsed;
  });

  ipcMain.handle(IPC_CHANNELS.browserSessionList, (_e, ...args: ReadonlyArray<unknown>) =>
    args.length === 0 ? browserSessions.list() : invalidArguments(),
  );

  ipcMain.handle(
    IPC_CHANNELS.browserSetBounds,
    (_e, ...args: ReadonlyArray<unknown>) => {
      if (args.length !== 2) return invalidArguments();
      const parsedSessionId = parseBrowserSessionId(args[0]);
      if (!parsedSessionId.ok) return parsedSessionId;
      const parsedBounds = parseBrowserSurfaceBounds(args[1]);
      return parsedBounds.ok
        ? browserSessions.setBounds(parsedSessionId.value, parsedBounds.value)
        : parsedBounds;
    },
  );
};
