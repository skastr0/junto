import { describe, expect, it } from "vitest";
import {
  crewPortLabel,
  edgePortMaskView,
  parsePortMask,
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

describe("parsePortMask", () => {
  it("dedupes and drops empty names", () => {
    expect(parsePortMask(["msg.send", "msg.send", "", 12])).toEqual(["msg.send"]);
    expect(crewPortLabel("msg.prompt")).toBe("Prompt immediately");
    expect(crewPortLabel("unknown.port")).toBe("unknown.port");
  });
});
