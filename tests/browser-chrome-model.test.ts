import { describe, expect, it } from "vitest";
import { initialPageDriving, reducePageDriving, type PageDriving } from "../src/shared/page-driver";
import { asNodeId } from "../src/shared/model";
import {
  addressParts,
  addressTarget,
  driverView,
  refusalLine,
  tabLabel,
  takeoverOffer,
} from "../src/renderer/lib/browser-chrome-model";

const seat = asNodeId("seat-ada");
const name = (id: string) => (id === seat ? "Ada" : undefined);

describe("addressTarget", () => {
  it("adds https to a bare host and keeps an explicit scheme", () => {
    expect(addressTarget("example.com/docs")).toEqual({ ok: true, url: "https://example.com/docs" });
    expect(addressTarget("  http://example.com ")).toEqual({ ok: true, url: "http://example.com/" });
  });

  it("refuses what main refuses, in the policy's words", () => {
    expect(addressTarget("")).toEqual({ ok: false, message: "Type an address." });
    expect(addressTarget("localhost:3000")).toMatchObject({ ok: false, message: expect.stringContaining("Local and internal") });
    expect(addressTarget("example.com:8080/x")).toEqual({ ok: true, url: "https://example.com:8080/x" });
    expect(addressTarget("https://192.168.1.1")).toMatchObject({ ok: false, message: expect.stringContaining("Private") });
    expect(addressTarget("file:///etc/passwd")).toMatchObject({ ok: false, message: expect.stringContaining("http and https") });
  });
});

describe("driverView and takeoverOffer", () => {
  it("reads idle, a running seat, a seat that drove, the operator and a held page", () => {
    expect(driverView(initialPageDriving, 0, name)).toMatchObject({ kind: "idle", live: false });
    const running = reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: seat, at: 1_000 });
    expect(driverView(running, 1_500, name)).toEqual({ kind: "seat", text: "Ada is driving", live: true, seat: "Ada" });
    const ended = reducePageDriving(running, { kind: "seat-end", nodeId: seat, at: 2_000 });
    expect(driverView(ended, 3_000, name)).toEqual({ kind: "seat", text: "Ada drove last", live: false, seat: "Ada" });
    expect(driverView(ended, 60_000, name).kind).toBe("idle");
    const operator = reducePageDriving(initialPageDriving, { kind: "operator-act", at: 1 });
    expect(driverView(operator, 2, name).text).toBe("You are driving");
    const held = reducePageDriving(initialPageDriving, { kind: "take-over", at: 1 });
    expect(driverView(held, 2, name)).toMatchObject({ kind: "operator-held", live: false });
  });

  it("names an unknown seat by its id", () => {
    const running = reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: asNodeId("seat-x"), at: 1 });
    expect(driverView(running, 2, name).text).toBe("seat-x is driving");
  });

  it("offers take over while seats may act and hand back while the operator holds", () => {
    expect(takeoverOffer(initialPageDriving)).toEqual({ action: "take-over", label: "Take over" });
    const held: PageDriving = reducePageDriving(initialPageDriving, { kind: "take-over", at: 1 });
    expect(takeoverOffer(held)).toEqual({ action: "release", label: "Hand back" });
  });
});

describe("tabLabel", () => {
  it("prefers the title, then the host, then a blank tab", () => {
    expect(tabLabel({ title: " Docs ", url: "https://example.com" })).toBe("Docs");
    expect(tabLabel({ title: "", url: "https://example.com/a" })).toBe("example.com");
    expect(tabLabel({ title: "", url: "" })).toBe("New tab");
  });
});

describe("refusalLine", () => {
  it("says every refusal kind in one line", () => {
    const lines = [
      refusalLine({ kind: "no_such_tab", tab: "t9" as never }),
      refusalLine({ kind: "last_tab", tab: "t1" as never }),
      refusalLine({ kind: "too_many_tabs", limit: 12 }),
      refusalLine({ kind: "bad_index", index: 99 }),
      refusalLine({ kind: "operator_holds", since: 1 }),
      refusalLine({ kind: "invalid", message: "The view is busy." }),
      refusalLine({ kind: "not_found" }),
    ];
    expect(lines.every((line) => line.length > 0 && line.endsWith("."))).toBe(true);
    expect(lines[2]).toContain("12");
    expect(lines[5]).toBe("The view is busy.");
  });
});

describe("addressParts", () => {
  it("sets the host apart from the scheme and the path, as typed", () => {
    expect(addressParts("https://docs.example.com/guide/start")).toEqual({ before: "https://", host: "docs.example.com", after: "/guide/start" });
    expect(addressParts("http://localhost:3000/")).toEqual({ before: "http://", host: "localhost:3000", after: "/" });
    expect(addressParts("https://Example.COM/A")).toEqual({ before: "https://", host: "Example.COM", after: "/A" });
  });

  it("has nothing to set apart on a blank or hostless address", () => {
    expect(addressParts("")).toBeUndefined();
    expect(addressParts("about:blank")).toBeUndefined();
    expect(addressParts("not an address")).toBeUndefined();
  });
});
