/**
 * The Page node as a kind seat: the host as its name and the full address as
 * its hover title, "browser page, <profile>" as its line, the ring working
 * while a seat drives it, blocked with the error in place of the line when
 * it failed, and resting while it only loads.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeOf } from "../src/shared/model";
import { formatNodeRef } from "../src/shared/node-ref";
import { PageCard } from "../src/renderer/components/browser/PageCard";
import { kindStateOf } from "../src/renderer/components/nodes/KindSeat";
import { browser$ } from "../src/renderer/lib/browser-state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { pageDriving$ } from "../src/renderer/lib/page-driving";
import { state$ } from "../src/renderer/lib/state";

const node = { kind: "page", id: "p1", url: "https://docs.example.com/guide?x=1", profile: "personal", onRemove: "kill-session" } as unknown as NodeOf<"page">;
const ref = formatNodeRef({ canvasName: "work", nodeId: "p1" });
const draw = () => renderToStaticMarkup(<PageCard node={node} />);
const seatState = (html: string) => /data-testid="kind-seat"[^>]*data-state="([^"]*)"/u.exec(html)?.[1];

describe("the page kind seat", () => {
  beforeEach(() => {
    state$.canvasName.set("work");
  });
  afterEach(() => {
    browser$.sessionByRef.set({});
    dock$.opErrorByRef.set({});
    pageDriving$.workingByRef.set({});
    state$.canvasName.set("");
  });

  it("names the host, titles the full address, and says the profile, resting at rest", () => {
    const html = draw();
    expect(html).toContain('title="https://docs.example.com/guide?x=1"');
    expect(html).toContain(">docs.example.com<");
    expect(html).toContain("browser page, personal");
    expect(html).toContain('data-kind="page"');
    expect(seatState(html)).toBe(kindStateOf(undefined));
  });

  it("works while a seat drives it, and rests while it only loads", () => {
    browser$.sessionByRef[ref].set({ ref, sessionId: "s1", nodeId: "p1", url: node.url, profile: "personal", state: "loading", attached: true });
    expect(seatState(draw())).toBe(kindStateOf(undefined));
    pageDriving$.workingByRef[ref].set(true);
    expect(seatState(draw())).toBe(kindStateOf("working"));
  });

  it("fails with the error as the line, the operator's own failure first", () => {
    browser$.sessionByRef[ref].set({ ref, sessionId: "s1", nodeId: "p1", url: node.url, profile: "personal", state: "failed", attached: false, lastError: "net::ERR_NAME_NOT_RESOLVED" });
    pageDriving$.workingByRef[ref].set(true);
    let html = draw();
    expect(seatState(html)).toBe(kindStateOf("failed"));
    expect(html).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(html).not.toContain("browser page, personal");
    // The hover title leads with the error, which the leaf line cuts short, then the address.
    expect(html).toContain('title="net::ERR_NAME_NOT_RESOLVED\nhttps://docs.example.com/guide?x=1"');
    dock$.opErrorByRef[ref].set({ op: "close", message: "The page could not be detached." });
    html = draw();
    expect(html).toContain("The page could not be detached.");
    expect(html).not.toContain("net::ERR_NAME_NOT_RESOLVED");
  });
});
