import { describe, expect, it } from "vitest";
import type { CanvasEdge } from "../src/shared/canvas";
import {
  authoredPortMaskOf,
  crewPortLabel,
  edgePortMaskView,
  parsePortMask,
  persistPortMaskEther,
  toggleAllowedPort,
} from "../src/renderer/lib/crew-port-mask";

describe("edgePortMaskView", () => {
  it("treats an omitted allow-list as the full compile", () => {
    const full = edgePortMaskView(
      ["msg.list", "msg.send", "terminal.read"],
      undefined,
      "messages",
    );
    expect(full.allowed).toBeUndefined();
    expect(full.chips.every((chip) => chip.granted)).toBe(true);
  });

  it("treats an empty allow-list as granting none", () => {
    const none = edgePortMaskView(["msg.send", "verdict.post"], [], "reviews");
    expect(none.allowed).toEqual([]);
    expect(none.chips.every((chip) => !chip.granted)).toBe(true);
  });

  it("subtracts only compiled ports and never grants a masked invention", () => {
    const view = edgePortMaskView(
      ["msg.list", "msg.send", "terminal.read"],
      ["msg.list", "msg.send", "msg.prompt"],
      "messages",
    );
    expect(view.allowed).toEqual(["msg.list", "msg.send"]);
    expect(view.chips.map((chip) => [chip.port, chip.granted])).toEqual([
      ["msg.list", true],
      ["msg.send", true],
      ["terminal.read", false],
    ]);
    expect(view.chips.find((chip) => chip.port === "terminal.read")?.attenuable).toBe(
      true,
    );
  });
});

describe("toggleAllowedPort", () => {
  it("writes an allow-list only when it differs from the compile", () => {
    expect(toggleAllowedPort(["msg.send", "msg.list"], undefined, "msg.send")).toEqual(
      ["msg.list"],
    );
    expect(toggleAllowedPort(["msg.send"], ["msg.send"], "msg.send")).toEqual([]);
    expect(toggleAllowedPort(["msg.send"], [], "msg.send")).toBeUndefined();
    expect(toggleAllowedPort(["msg.send"], undefined, "msg.prompt")).toBeUndefined();
  });
});

describe("authoredPortMaskOf", () => {
  const wire = (ether: CanvasEdge["ether"]): CanvasEdge => ({
    id: "e1",
    fromNode: "a",
    toNode: "b",
    ether,
  });

  it("reads ether.mask as the allow-list", () => {
    expect(authoredPortMaskOf(wire({ verb: "messages" }))).toBeUndefined();
    expect(authoredPortMaskOf(wire({ verb: "messages", mask: [] }))).toEqual([]);
    expect(
      authoredPortMaskOf(wire({ verb: "messages", mask: ["msg.send"] })),
    ).toEqual(["msg.send"]);
  });
});

describe("persistPortMaskEther", () => {
  it("writes the live mask field so compile and scrub keep attenuation", () => {
    expect(persistPortMaskEther("messages", undefined)).toEqual({
      verb: "messages",
    });
    expect(persistPortMaskEther("messages", ["msg.send"])).toEqual({
      verb: "messages",
      mask: ["msg.send"],
    });
    expect(persistPortMaskEther("messages", [])).toEqual({
      verb: "messages",
      mask: [],
    });
  });
});

describe("parsePortMask", () => {
  it("dedupes and drops empty names", () => {
    expect(parsePortMask(["msg.send", "msg.send", "", 12])).toEqual(["msg.send"]);
    expect(crewPortLabel("msg.prompt")).toBe("Prompt immediately");
    expect(crewPortLabel("unknown.port")).toBe("unknown.port");
  });
});
