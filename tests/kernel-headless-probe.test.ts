import { describe, expect, it } from "vitest";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { agentKeysForExecutableSource } from "../src/shared/station";
import {
  KERNEL_PROBE_AGENT_KEY,
  KERNEL_PROBE_TIMER_ID,
  makeKernelHeadlessFixture,
} from "../scripts/kernel-headless-fixture";

describe("kernel headless proof fixture", () => {
  it("is a valid canvas with an executable timer routed to the local agent", () => {
    const doc = makeKernelHeadlessFixture();
    const timer = doc.nodes.find((node) => node.id === KERNEL_PROBE_TIMER_ID);

    expect(decodeCanvasDoc(doc)._tag).toBe("Right");
    expect(timer?.ether?.entity?.kind).toBe("timer");
    expect(
      agentKeysForExecutableSource(
        doc,
        KERNEL_PROBE_TIMER_ID,
        "remote",
        "local",
      ),
    ).toEqual([KERNEL_PROBE_AGENT_KEY]);
  });

  it("does not treat shared region membership as automatic delivery", () => {
    const doc = makeKernelHeadlessFixture();
    const edgeFree = { ...doc, edges: [] };

    expect(
      agentKeysForExecutableSource(
        edgeFree,
        KERNEL_PROBE_TIMER_ID,
        "remote",
        "local",
      ),
    ).toEqual([]);
  });
});
