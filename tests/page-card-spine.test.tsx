/**
 * The Page chip in the Spines language: the host as its name and the full
 * address as its hover title, "browser page, <profile>" below, Working while
 * a seat drives it, Failed with the error in place of the line, and nothing
 * while it only loads.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeOf } from "../src/shared/model";
import { formatNodeRef } from "../src/shared/node-ref";
import { PageCard } from "../src/renderer/components/browser/PageCard";
import { browser$ } from "../src/renderer/lib/browser-state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { pageDriving$ } from "../src/renderer/lib/page-driving";
import { state$ } from "../src/renderer/lib/state";

const node = { kind: "page", id: "p1", url: "https://docs.example.com/guide?x=1", profile: "personal", onRemove: "kill-session" } as unknown as NodeOf<"page">;
const ref = formatNodeRef({ canvasName: "work", nodeId: "p1" });
const draw = () => renderToStaticMarkup(<PageCard node={node} />);
const tag = (html: string) => /class="spine-tag"[^>]*>.*?<\/span>([^<]*)</u.exec(html)?.[1];

describe("the Spines page chip", () => {
  beforeEach(() => {
    state$.canvasName.set("work");
  });
  afterEach(() => {
    browser$.sessionByRef.set({});
    dock$.opErrorByRef.set({});
    pageDriving$.workingByRef.set({});
    state$.canvasName.set("");
  });

  it("names the host, titles the full address, and says the profile, with no tag at rest", () => {
    const html = draw();
    expect(html).toContain('title="https://docs.example.com/guide?x=1"');
    expect(html).toContain(">docs.example.com<");
    expect(html).toContain("browser page, personal");
    expect(html).toContain('data-hue="indigo"');
    expect(html).not.toContain("spine-tag");
  });

  it("says Working while a seat drives it, and nothing while it only loads", () => {
    browser$.sessionByRef[ref].set({ ref, sessionId: "s1", nodeId: "p1", url: node.url, profile: "personal", state: "loading", attached: true });
    expect(draw()).not.toContain("spine-tag");
    pageDriving$.workingByRef[ref].set(true);
    expect(tag(draw())).toBe("Working");
  });

  it("says Failed with the error as the line, the operator's own failure first", () => {
    browser$.sessionByRef[ref].set({ ref, sessionId: "s1", nodeId: "p1", url: node.url, profile: "personal", state: "failed", attached: false, lastError: "net::ERR_NAME_NOT_RESOLVED" });
    pageDriving$.workingByRef[ref].set(true);
    let html = draw();
    expect(tag(html)).toBe("Failed");
    expect(html).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(html).not.toContain("browser page, personal");
    dock$.opErrorByRef[ref].set({ op: "close", message: "The page could not be detached." });
    html = draw();
    expect(html).toContain("The page could not be detached.");
    expect(html).not.toContain("net::ERR_NAME_NOT_RESOLVED");
  });
});
