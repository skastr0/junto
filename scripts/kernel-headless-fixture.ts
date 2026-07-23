import type { CanvasDoc } from "../src/shared/canvas";

export const KERNEL_PROBE_CANVAS = "__kernel-probe-fixture__";
export const KERNEL_PROBE_REGION_ID = "probe-region";
export const KERNEL_PROBE_TIMER_ID = "probe-timer";
export const KERNEL_PROBE_AGENT_ID = "probe-agent";
export const KERNEL_PROBE_AGENT_KEY = "local:default";
export const KERNEL_PROBE_TIMER_EVERY_MINUTES = 0.02;

/**
 * Isolated headless-proof document. The timer is an executable entity and its
 * human-authored edge is the only automatic route to the agent. Spatial
 * containment supplies arming + instruction context; it is not delivery ACL.
 */
export const makeKernelHeadlessFixture = (): CanvasDoc => ({
  nodes: [
    {
      id: KERNEL_PROBE_REGION_ID,
      type: "group",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      label: "probe region",
      ether: {
        region: { instruction: "[probe] reply with the single word ack" },
      },
    },
    {
      id: KERNEL_PROBE_TIMER_ID,
      type: "text",
      x: 20,
      y: 20,
      width: 200,
      height: 80,
      text: "probe timer",
      ether: {
        entity: { kind: "timer" },
        host: "local",
        timer: { everyMinutes: KERNEL_PROBE_TIMER_EVERY_MINUTES },
      },
    },
    {
      id: KERNEL_PROBE_AGENT_ID,
      type: "text",
      x: 20,
      y: 140,
      width: 200,
      height: 80,
      text: "probe agent",
      ether: {
        entity: { kind: "agent", name: KERNEL_PROBE_AGENT_KEY },
        host: "local",
      },
    },
  ],
  edges: [
    {
      id: "probe-timer-to-agent",
      fromNode: KERNEL_PROBE_TIMER_ID,
      toNode: KERNEL_PROBE_AGENT_ID,
    },
  ],
});
