/**
 * The window's browser, where it needs the core (junto/browser/ipc.ts): a
 * page ref resolved against the canvases, the pool limits from Settings, and
 * the operator's box comment. Main draws the box and takes its shot, since
 * the page is Electron's; the core stages the shot, posts it and releases it,
 * so the staged shots live beside the content store that holds their bytes.
 */
import { Effect } from "effect";
import { makePageTargetResolver, type PageTargetResult } from "../../junto/browser/page-target";
import { ModelService } from "../../junto/model/service";
import { SettingsService } from "../../junto/settings/service";
import {
  discardOperatorPageBox,
  postStagedPageBox,
  releaseStagedShots,
  stageOperatorPageBox,
  type DrawnPageShot,
  type OperatorPage,
  type OperatorPageBoxCommented,
  type OperatorPageBoxDrawn,
} from "../../junto/work/page-box-comment";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "browser.pageTarget": CoreOp<{ readonly ref: unknown }, PageTargetResult>;
    "browser.poolLimits": CoreOp<Record<string, never>, { readonly maxVisibleSurfaces: number; readonly maxWarmSessions: number }>;
    "pageBox.stage": CoreOp<{ readonly sessionId: string; readonly page: OperatorPage; readonly shot: DrawnPageShot }, OperatorPageBoxDrawn>;
    "pageBox.operatorPost": CoreOp<
      { readonly page: OperatorPage | undefined; readonly sessionId: string; readonly shotId: string; readonly text: string },
      OperatorPageBoxCommented
    >;
    "pageBox.discard": CoreOp<{ readonly sessionId: string; readonly shotId: string }, void>;
    /** Every staged shot of a session that ended. */
    "pageBox.releaseSession": CoreOp<{ readonly sessionId: string }, void>;
  }
}

coreOps({
  "browser.pageTarget": ({ ref }) =>
    Effect.flatMap(ModelService, (canvases) => Effect.promise(() => makePageTargetResolver(canvases)(ref))),
  // Settings.browser is the sole durable SoT for pool limits.
  "browser.poolLimits": () =>
    Effect.flatMap(SettingsService, (settings) =>
      Effect.map(settings.get, (doc) => ({
        maxVisibleSurfaces: doc.browser.maxVisibleSurfaces,
        maxWarmSessions: doc.browser.maxWarmSessions,
      }))),
  "pageBox.stage": ({ sessionId, page, shot }) => stageOperatorPageBox(sessionId, page, shot),
  "pageBox.operatorPost": ({ page, sessionId, shotId, text }) => postStagedPageBox(page, { sessionId, shotId, text }),
  "pageBox.discard": ({ sessionId, shotId }) => discardOperatorPageBox(sessionId, shotId),
  "pageBox.releaseSession": ({ sessionId }) => releaseStagedShots(sessionId),
});
