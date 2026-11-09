// One message protocol for the engine, whichever thread or process hosts it.

import { buildBoard } from "./board.js";
import { createEngine } from "./engine.js";
import { buildGlyphAtlas } from "./sdf.js";

export function serveEngine(post) {
  let engine = null;
  const waiting = [];
  const fail = (message) => post({ type: "error", message });

  const init = async (m) => {
    const t0 = performance.now();
    const response = await fetch(new URL("./board.json", self.location.href));
    const model = (await response.json()).model;
    const atlas = buildGlyphAtlas();
    const board = buildBoard(model, m.scale, atlas);
    const built = performance.now();
    engine = await createEngine({
      canvas: m.canvas,
      width: m.width,
      height: m.height,
      dpr: m.dpr,
      board,
      atlas,
      soft: m.soft === true,
      onStats: (stats) => post({ type: "stats", ...stats }),
      onError: fail,
    });
    post({ type: "ready", info: { ...engine.info, buildMs: built - t0, startMs: performance.now() - t0 } });
    for (const queued of waiting) handle(queued);
    waiting.length = 0;
  };

  function handle(m) {
    if (m.type === "init") {
      init(m).catch((error) => fail(String(error?.stack ?? error)));
      return;
    }
    if (!engine) {
      waiting.push(m);
      return;
    }
    if (m.type === "wheel" || m.type === "drag") engine.input(m);
    else if (m.type === "move") engine.pointer(m);
    else if (m.type === "reports") engine.reports(m.batch);
    else if (m.type === "resize") engine.resize(m.width, m.height, m.dpr);
    else if (m.type === "collect") post({ type: "reply", id: m.id, data: engine.collect() });
  }
  return handle;
}
