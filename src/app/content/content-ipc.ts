/**
 * Main's handlers of the window's content group (src/contract/window/content.ts):
 * the operator's attachment pieces, an image put, and the portrait overrides,
 * each asked of the core's content group as it is. A portrait save is still
 * broadcast to every window as it stands, after the call.
 *
 * And the one call main makes through the same group for itself: the
 * operator's purge of a page box comment's shot, which runs under the
 * main-authoring gate its handler holds.
 */
import { BrowserWindow } from "electron";
import { Context, Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { PageShotPurged, PageShotPurgeRequest } from "@shared/page-shot";
import type { PortraitOverrideEvent } from "@shared/portrait-overrides";
import { ContentCore } from "../../contract/core/content";
import { ContentWindowRpcs } from "../../contract/window/content";
import { AppRuntime } from "../runtime";
import { isTrustedMainWebContents } from "../trusted-main-webcontents";
import { forwardTo, fromCore } from "../window/ipc";

/** One seat's override as it now stands, to every window. */
const broadcastPortraitOverride = (event: PortraitOverrideEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed() || !isTrustedMainWebContents(window.webContents)) continue;
    window.webContents.send(IPC_CHANNELS.portraitOverride, event);
  }
};

export const ContentWindowHandlers = ContentWindowRpcs.toLayer(
  Effect.gen(function* () {
    const content = yield* ContentCore;
    return {
      ...forwardTo(ContentWindowRpcs.omit("ContentPortraitOverrideSet"), content),
      // Portrait overrides are an install-local preference like settings (no
      // canvas authoring), so a save runs outside the main-authoring gate.
      ContentPortraitOverrideSet: (input) =>
        fromCore(content.ContentPortraitOverrideSet(input)).pipe(
          Effect.tap((saved) =>
            Effect.sync(() => {
              if (saved.ok) broadcastPortraitOverride({ seatId: saved.seatId, override: saved.override });
            }),
          ),
        ),
    };
  }),
);

export type ContentAsks = {
  /** The operator's purge of a page box comment's shot. */
  readonly purgePageShot: (comment: PageShotPurgeRequest) => Promise<PageShotPurged>;
};

export const contentAsks = (core: Context.Context<ContentCore>): ContentAsks => {
  const content = Context.get(core, ContentCore);
  return {
    purgePageShot: (comment) => AppRuntime.runPromise(content.ContentPageShotPurge(comment)),
  };
};
