/**
 * The core's handlers of the browser group (src/contract/core/browser.ts):
 * a page ref resolved against the canvases, the pool limits from Settings,
 * and the operator's box comment. Main draws the box and takes its shot,
 * since the page is Electron's; the core stages the shot, posts it and
 * releases it, so the staged shots live beside the content store that holds
 * their bytes.
 */
import { Effect } from "effect";
import { BrowserPoolLimitsUnavailable, BrowserRpcs } from "../../contract/core/browser";
import { makePageTargetResolver } from "../browser/page-target";
import { ModelService } from "../model/service";
import { SettingsService } from "../settings/service";
import { discardOperatorPageBox, postStagedPageBox, releaseStagedShots, stageOperatorPageBox } from "../work/page-box-comment";

export const BrowserHandlers = BrowserRpcs.toLayer(
  Effect.gen(function* () {
    const resolve = makePageTargetResolver(yield* ModelService);
    const settings = yield* SettingsService;
    return {
      BrowserPageTarget: ({ ref }) => Effect.promise(() => resolve(ref)),
      BrowserPoolLimits: () =>
        settings.get.pipe(
          Effect.map((doc) => ({ maxVisibleSurfaces: doc.browser.maxVisibleSurfaces, maxWarmSessions: doc.browser.maxWarmSessions })),
          Effect.mapError((error) => new BrowserPoolLimitsUnavailable({ message: error.message })),
        ),
      BrowserPageBoxStage: ({ sessionId, page, shot }) => stageOperatorPageBox(sessionId, page, shot),
      BrowserPageBoxPost: ({ page, sessionId, shotId, text }) => postStagedPageBox(page, { sessionId, shotId, text }),
      BrowserPageBoxDiscard: ({ sessionId, shotId }) => discardOperatorPageBox(sessionId, shotId),
      BrowserPageBoxReleaseSession: ({ sessionId }) => releaseStagedShots(sessionId),
    };
  }),
);
