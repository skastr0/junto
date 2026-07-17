import type { IpcMain, WebContents } from "electron";
import { Effect } from "effect";
import {
  IPC_CHANNELS,
  type BrowserOpenInput,
} from "@shared/ipc";
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

const isBrowserOpenInput = (input: unknown): input is BrowserOpenInput =>
  typeof input === "object" &&
  input !== null &&
  "ref" in input &&
  Object.keys(input).join(",") === "ref" &&
  typeof input.ref === "string" &&
  input.ref.length > 0 &&
  isUtf8WithinLimit(input.ref, BROWSER_MAX_REF_BYTES);

export const registerBrowserIpc = (
  ipcMain: IpcMain,
  browserSessions: BrowserSessionService,
  webContentsGetter: () => Iterable<WebContents>,
  pageTargetResolver: PageTargetResolver = resolveBrowserPageTarget,
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
    const target = await pageTargetResolver(input.ref);
    return target.ok ? browserSessions.open(target.data) : target;
  });

  ipcMain.handle(IPC_CHANNELS.browserClose, (_e, ...args: ReadonlyArray<unknown>) => {
    if (args.length !== 1) return invalidArguments();
    const parsed = parseBrowserSessionId(args[0]);
    return parsed.ok ? browserSessions.close(parsed.value) : parsed;
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
