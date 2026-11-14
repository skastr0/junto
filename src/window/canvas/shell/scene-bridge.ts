/**
 * The GPU canvas's scene feed (docs/canvas-gpu-architecture.md, section 20).
 *
 * The feed (canvas/feed) already derives every fact the canvas draws, with no
 * card mounted: the model rows, each seat's live state, selection, theme and
 * wire pulses. This module is the shell's side of it: hold the canvas open
 * until its first read lands, then retain the feed and hand its ops to the
 * engine. Waiting for the read is what keeps a late-opening canvas from
 * loading an empty board for the life of the page.
 */

import { observe } from "@legendapp/state";
import type { SceneOp } from "../contract";
import { state$ } from "../../lib/state";
import { modelStore } from "../../lib/use-model";
import { retainCanvasFeed } from "../feed";
import type { WindowRuntime } from "../../rpc/runtime";

type Sink = {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
};

/**
 * Follow the open canvas and hand the feed's ops to `sink`. Returns the
 * release. The sink hears the load once the first read has landed, then one
 * op per changed row, seat report, selection move, theme switch or pulse.
 */
export const startSceneBridge = (
  sink: Sink,
  runtime?: WindowRuntime,
): (() => void) => {
  let closed = false;
  let name = "";
  let releaseOpen: (() => void) | undefined;
  let releaseFeed: (() => void) | undefined;

  const close = (): void => {
    releaseFeed?.();
    releaseFeed = undefined;
    releaseOpen?.();
    releaseOpen = undefined;
  };

  const attach = (canvasName: string): void => {
    close();
    name = canvasName;
    if (closed || canvasName === "") return;
    // Hold the canvas open for the read. The feed opens its own hold when it
    // starts; this one only spans the wait, so the one load it sends carries
    // the rows instead of the empty board.
    const open = modelStore.open(canvasName);
    releaseOpen = open;
    void modelStore.ready(canvasName).then(() => {
      if (closed || name !== canvasName) return;
      releaseFeed = retainCanvasFeed(canvasName, (ops) => sink.apply(ops), runtime);
      open();
      if (releaseOpen === open) releaseOpen = undefined;
    });
  };

  // Attach before the observer exists: observe runs its body at once, and a
  // second attach of the same canvas would hold it twice and load it twice.
  attach(state$.canvasName.peek());
  const offName = observe(() => {
    const next = state$.canvasName.get();
    if (next !== name) attach(next);
  });

  return () => {
    if (closed) return;
    closed = true;
    offName();
    close();
  };
};
