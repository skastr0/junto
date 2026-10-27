// The spike page: one editor on the fixture, picked by ?editor=, themed by
// ?theme=. It times opening (to the first frame with highlighted code) and
// gives the driver text, caret placement and a warm reopen.
import fixture from "./fixture.ts?raw";

const params = new URLSearchParams(location.search);
const which = params.get("editor") ?? "pierre";
const theme = (params.get("theme") ?? "dark") as "dark" | "light";
document.body.dataset.theme = theme;
const root = document.getElementById("root")!;

export type Mounted = {
  getText: () => string;
  host: () => Element | ShadowRoot | null;
  caretLine: () => number;
  focusLineEnd: (line: number) => void;
  unmount: () => void;
};

declare global {
  interface Window {
    spike: {
      ready?: number;
      firstText?: number;
      readyWarm?: number;
      mounted?: Mounted;
      longTasksToReady?: number;
      reopen: () => Promise<number>;
      fixture: string;
    };
  }
}

const TOKEN = which === "cm" ? ".cm-line span[class]" : 'span[style*="--diffs-token"]';

let longTask = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) longTask += entry.duration;
}).observe({ type: "longtask", buffered: true });

const mount = async (): Promise<Mounted> => {
  if (which === "cm") return (await import("./cm")).mountCodeMirror(root, fixture, theme);
  return (await import("./pierre")).mountPierre(root, fixture, theme, which !== "pierre", which === "pierre-worker", which === "pierre-wasm" ? "shiki-wasm" : which === "pierre-highlights" ? "highlights" : undefined);
};

/** Resolves at the first frame whose DOM holds a highlighted token. */
const highlighted = (mounted: Mounted) =>
  new Promise<number>((resolve) => {
    const tick = () => {
      if (mounted.host()?.querySelector(TOKEN)) requestAnimationFrame(() => resolve(performance.now()));
      else requestAnimationFrame(tick);
    };
    tick();
  });

window.spike = {
  fixture,
  reopen: async () => {
    window.spike.mounted?.unmount();
    root.replaceChildren();
    await new Promise((r) => setTimeout(r, 200));
    const t = performance.now();
    const mounted = await mount();
    window.spike.mounted = mounted;
    const done = await highlighted(mounted);
    return done - t;
  },
};
const LINE = which === "cm" ? ".cm-line" : "[data-line]";
const mounted = await mount();
window.spike.mounted = mounted;
const textTick = () => {
  if (mounted.host()?.querySelector(LINE)) requestAnimationFrame(() => (window.spike.firstText = performance.now()));
  else requestAnimationFrame(textTick);
};
textTick();
window.spike.ready = await highlighted(mounted);
window.spike.longTasksToReady = longTask;
