// @vitest-environment jsdom
/**
 * A shadow root that draws marks (the website's kit) keeps its own copy of
 * the ring atlas sheet, read off its host: a selector inside it cannot reach
 * the page's <html>, so without the rewrite every ring there would hold its
 * rest pose.
 */
import { afterEach, expect, it } from "vitest";
import { mirrorMarkAtlas, resetMarkAtlasForTests } from "../src/renderer/lib/activity-atlas";

afterEach(() => resetMarkAtlasForTests());

it("mirrors the atlas sheet into a shadow root, gated on the host, and takes it back", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const undo = mirrorMarkAtlas(root);
  const css = root.querySelector("style[data-junto-mark-atlas]")?.textContent ?? "";
  expect(css).toContain('@keyframes junto-mark-turn');
  expect(css).toContain(':host(:not([data-surface-motion="paused"])) .junto-mark[data-mark-visible]>.junto-mark__part{display:block}');
  expect(css).not.toMatch(/(^|[\s,}])html[:[ ]/);
  // The page keeps its own sheet, on <html>.
  expect(document.getElementById("junto-mark-atlas")?.textContent).toContain('html:not([data-surface-motion="paused"])');
  undo();
  expect(root.querySelector("style[data-junto-mark-atlas]")).toBeNull();
  host.remove();
});
