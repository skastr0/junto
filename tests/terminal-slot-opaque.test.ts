import { afterEach, describe, expect, it } from "vitest";
import {
  registerTerminalSlot,
  terminalSlotElement,
  terminalSlots$,
} from "../src/renderer/lib/terminal-state";

afterEach(() => {
  for (const nodeId of Object.keys(terminalSlots$.generationByNodeId.peek())) {
    registerTerminalSlot(nodeId, null);
  }
});

describe("registerTerminalSlot", () => {
  it("keeps a cyclic host out of Legend and still returns it", () => {
    const host = { owner: null as unknown };
    host.owner = host;
    expect(() => registerTerminalSlot("t1", host as unknown as HTMLElement)).not.toThrow();
    expect(terminalSlotElement("t1")).toBe(host);
    expect(terminalSlots$.generationByNodeId.t1.peek()).toBe(1);
    expect(terminalSlots$.generationByNodeId.peek()).not.toHaveProperty("owner");
  });

  it("clears the slot on unmount", () => {
    const host = { owner: null as unknown };
    host.owner = host;
    registerTerminalSlot("t1", host as unknown as HTMLElement);
    registerTerminalSlot("t1", null);
    expect(terminalSlotElement("t1")).toBeNull();
    expect(terminalSlots$.generationByNodeId.t1.peek()).toBeUndefined();
  });

  it("bumps generation when the same node remounts a slot", () => {
    const first = { id: "a" } as unknown as HTMLElement;
    const second = { id: "b" } as unknown as HTMLElement;
    registerTerminalSlot("t1", first);
    expect(terminalSlots$.generationByNodeId.t1.peek()).toBe(1);
    registerTerminalSlot("t1", second);
    expect(terminalSlotElement("t1")).toBe(second);
    expect(terminalSlots$.generationByNodeId.t1.peek()).toBe(2);
  });
});
