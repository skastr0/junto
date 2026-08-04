import { describe, expect, it } from "vitest";
import type { CanvasNode, GroupNode, TextNode } from "../src/shared/canvas";
import { describeConnectPreview } from "../src/renderer/lib/connect-preview";

const textNode = (kind: string | undefined): TextNode => ({
  id: `node-${kind ?? "note"}`,
  type: "text",
  text: kind ?? "note",
  x: 0,
  y: 0,
  width: 240,
  height: 100,
  ...(kind ? { ether: { entity: { kind } } } : {}),
});

const regionNode: GroupNode = {
  id: "region-1",
  type: "group",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
};

describe("describeConnectPreview", () => {
  it("actor(agent) -> actor(agent): default mailbox ports", () => {
    const preview = describeConnectPreview(textNode("agent"), textNode("agent"));
    expect(preview.fromRole).toBe("actor");
    expect(preview.toRole).toBe("actor");
    expect(preview.ports).toEqual(["msg.list", "msg.send"]);
    expect(preview.label).toBe("allows 2 actions");
  });

  it("actor(agent) -> sink(page): full grant, target's browser port", () => {
    const preview = describeConnectPreview(textNode("agent"), textNode("page"));
    expect(preview.toRole).toBe("sink");
    expect(preview.ports).toEqual(["browser.automate"]);
    expect(preview.label).toBe("allows 1 action");
  });

  it("actor(agent) -> sink(project): full grant but zero offers -> grantless", () => {
    const preview = describeConnectPreview(textNode("agent"), textNode("project"));
    expect(preview.ports).toEqual([]);
    expect(preview.label).toBe("connects, allows nothing yet");
  });

  it("sink(terminal) -> sink(terminal): a raw shell is not an actor -> grantless", () => {
    const preview = describeConnectPreview(textNode("terminal"), textNode("terminal"));
    expect(preview.fromRole).toBe("sink");
    expect(preview.toRole).toBe("sink");
    expect(preview.ports).toEqual([]);
    expect(preview.label).toBe("connects, allows nothing yet");
  });

  it("actor(agent) -> scheduler(watcher): role law denies -> grantless", () => {
    const preview = describeConnectPreview(textNode("agent"), textNode("watcher"));
    expect(preview.toRole).toBe("scheduler");
    expect(preview.ports).toEqual([]);
    expect(preview.label).toBe("connects, allows nothing yet");
  });

  it("sink(task) -> actor(agent): non-actor source is denied by role law -> grantless", () => {
    const preview = describeConnectPreview(textNode("task"), textNode("agent"));
    expect(preview.fromRole).toBe("sink");
    expect(preview.ports).toEqual([]);
    expect(preview.label).toBe("connects, allows nothing yet");
  });

  it("geography (plain note) -> actor(agent): geography source is denied -> grantless", () => {
    const preview = describeConnectPreview(textNode(undefined), textNode("agent"));
    expect(preview.fromRole).toBe("geography");
    expect(preview.ports).toEqual([]);
    expect(preview.label).toBe("connects, allows nothing yet");
  });

  it("region group -> actor(agent): geography source is denied -> grantless", () => {
    const preview = describeConnectPreview(regionNode as CanvasNode, textNode("agent"));
    expect(preview.fromRole).toBe("geography");
    expect(preview.ports).toEqual([]);
    expect(preview.label).toBe("connects, allows nothing yet");
  });

  it("undefined endpoints resolve to geography on both sides -> grantless", () => {
    const preview = describeConnectPreview(undefined, undefined);
    expect(preview.fromRole).toBe("geography");
    expect(preview.toRole).toBe("geography");
    expect(preview.ports).toEqual([]);
  });
});
