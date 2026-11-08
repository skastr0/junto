/**
 * What Electron main's own boot (`src/app/index.ts`) asks the core, on main's
 * clients of it: the main-index group (src/contract/core/main-index.ts) and
 * this machine's settings record from the settings group. `index.ts` holds
 * these calls and runs no effect itself; each one runs on main's runtime here.
 */
import { Context } from "effect";
import type { ContentRef } from "@shared/content";
import type { NodeRef } from "@shared/node-ref";
import type { MachineSettings } from "@shared/settings";
import { MainIndexCore, type SeatPageBoxTarget, type SeatPageShot } from "../../contract/core/main-index";
import { SettingsCore } from "../../contract/core/settings";
import { AppRuntime } from "../runtime";

export const mainIndexCalls = (core: Context.Context<MainIndexCore | SettingsCore>) => {
  const index = Context.get(core, MainIndexCore);
  const settings = Context.get(core, SettingsCore);
  // Built field by field: a caller's value may carry more than the core is handed.
  const rect = (box: SeatPageBoxTarget["rect"]): SeatPageBoxTarget["rect"] => ({ x: box.x, y: box.y, w: box.w, h: box.h });
  const target = (request: SeatPageBoxTarget): SeatPageBoxTarget => ({
    owner: request.owner,
    sessionId: request.sessionId,
    seatNodeId: request.seatNodeId,
    pageRef: request.pageRef,
    rect: rect(request.rect),
    text: request.text,
  });
  return {
    /** The canonical key of the node a link names; rejects when the core holds no such node. */
    resolveNodeRef: (ref: NodeRef) =>
      AppRuntime.runPromise(
        index.MainIndexResolveNodeRef({
          ref: { canvasName: ref.canvasName, nodeId: ref.nodeId, ...(ref.itemId === undefined ? {} : { itemId: ref.itemId }) },
        }),
      ),
    canvases: () => AppRuntime.runPromise(index.MainIndexCanvases()),
    editsCanvas: (canvasName: string) => AppRuntime.runPromise(index.MainIndexEditsCanvas({ canvasName })),
    watchCanvases: () => AppRuntime.runPromise(index.MainIndexWatchCanvases()),
    /** The work socket's pause source, read in the core on every request; never cached here. */
    canvasPlaying: (canvas: string) => AppRuntime.runPromise(index.MainIndexCanvasPlaying({ canvas })),
    openForRead: (ref: ContentRef) => AppRuntime.runPromise(index.MainIndexOpenForRead({ ref })),
    pageBoxCheck: (request: SeatPageBoxTarget) => AppRuntime.runPromise(index.MainIndexPageBoxCheck(target(request))),
    pageBoxPost: (request: SeatPageBoxTarget, shot: SeatPageShot) =>
      AppRuntime.runPromise(
        index.MainIndexPageBoxPost({
          request: target(request),
          shot: { png: shot.png, url: shot.url, scroll: { x: shot.scroll.x, y: shot.scroll.y }, rect: rect(shot.rect) },
        }),
      ),
    /** This machine's own record, as the window reads it; rejects when the core could not read the settings. */
    machine: (): Promise<MachineSettings> =>
      AppRuntime.runPromise(settings.SettingsGet()).then((answer) => {
        if (answer.settings === undefined) throw new Error(answer.message ?? "the core could not read the settings");
        return answer.settings.machine;
      }),
  };
};

export type MainIndexCalls = ReturnType<typeof mainIndexCalls>;
