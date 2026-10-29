// @vitest-environment jsdom
/**
 * A shadow root that draws marks (the website's kit) keeps its own copy of
 * the ring atlas sheet, read off its host: a selector inside it cannot reach
 * the page's <html>, so without the rewrite every ring there would hold its
 * rest pose.
 */
import { afterEach, expect, it, vi } from "vitest";
import { ensureMarkAtlas, mirrorMarkAtlas, resetMarkAtlasForTests } from "../src/renderer/lib/activity-atlas";

afterEach(() => {
  vi.restoreAllMocks();
  resetMarkAtlasForTests();
});

/** jsdom has no canvas: a context that takes every call, and a picture per paint. */
const paintableCanvas = (): void => {
  const ctx: object = new Proxy({}, { get: (_target, key) => (key === "canvas" ? undefined : () => ctx), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  let paints = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => `data:image/png;base64,atlas${String((paints += 1))}`);
};

it("mirrors the atlas sheet into a shadow root, gated on the host, and takes it back", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const undo = mirrorMarkAtlas(root);
  const css = root.querySelector("style[data-junto-mark-atlas]")?.textContent ?? "";
  expect(css).toContain('@keyframes junto-mark-turn');
  // Live only while the host is not paused and the reader has not asked for reduced motion.
  expect(css).toContain('@media (prefers-reduced-motion:no-preference){:host(:not([data-surface-motion="paused"])) .junto-mark[data-mark-visible]>.junto-mark__part{display:block}}');
  expect(css.split("\n").filter((rule) => rule.includes(":host(:not(") && !rule.startsWith("@media (prefers-reduced-motion:no-preference){"))).toEqual([]);
  expect(css).not.toMatch(/(^|[\s,}])html[:[ ]/);
  // The page keeps its own sheet, on <html>.
  expect(document.getElementById("junto-mark-atlas")?.textContent).toContain('html:not([data-surface-motion="paused"])');
  undo();
  expect(root.querySelector("style[data-junto-mark-atlas]")).toBeNull();
  host.remove();
});

it("rewrites both themes' atlas rules onto the host, leaving no html selector in the mirror", () => {
  paintableCanvas();
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const undo = mirrorMarkAtlas(root);
  expect(ensureMarkAtlas("dark")).toBe(true);
  expect(ensureMarkAtlas("bright")).toBe(true);
  const page = document.getElementById("junto-mark-atlas")?.textContent ?? "";
  const css = root.querySelector("style[data-junto-mark-atlas]")?.textContent ?? "";
  // The page has every theme rule on <html>; the mirror has each on the host.
  expect(page).toContain('html[data-theme="bright"] .junto-mark{background-image:url("data:image/png;base64,atlas2")}');
  expect(page).toContain('html [data-mark-theme="dark"] .junto-mark');
  expect(css).toContain(':host([data-theme="bright"]) .junto-mark{background-image:url("data:image/png;base64,atlas2")}');
  expect(css).toContain(':host [data-mark-theme="dark"] .junto-mark{background-image:url("data:image/png;base64,atlas1")}');
  expect(css).toContain(':host [data-mark-theme="bright"] .junto-mark');
  expect(css).not.toMatch(/(^|[\s,}])html[:[ ]/);
  undo();
  host.remove();
});
