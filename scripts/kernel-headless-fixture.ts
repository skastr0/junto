import type { CanvasDoc } from "../src/shared/canvas";

export const KERNEL_PROBE_CANVAS = "kernel-probe-fixture";
export const KERNEL_PROBE_REGION_ID = "probe-region";
export const KERNEL_PROBE_TIMER_ID = "probe-timer";
export const KERNEL_PROBE_AGENT_ID = "probe-agent";
export const KERNEL_PROBE_AGENT_KEY = "local:default";
export const KERNEL_PROBE_HOST_ID = "local";
export const KERNEL_PROBE_TIMER_EVERY_MINUTES = 0.02;

/**
 * The probe seeds this through SettingsService after StationRepository has
 * minted the installation identity. `local` is therefore an explicit
 * Command Center host binding, never an unresolved-placement fallback.
 */
export const KERNEL_PROBE_COMMAND_CENTER_TOPOLOGY = {
  role: "command-center" as const,
  hostId: KERNEL_PROBE_HOST_ID,
  supervisedPreferred: false,
};

/**
 * Isolated headless-proof document. The timer is an executable entity and its
 * human-authored edge is the only automatic route to the agent. Spatial
 * containment supplies region briefing context (onboard); it is not delivery ACL.
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
        host: KERNEL_PROBE_HOST_ID,
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
        host: KERNEL_PROBE_HOST_ID,
        terminal: {
          bindingId: "kernel-probe-agent-seat",
          harness: "hermes",
          launch: {
            kind: "harness",
            argv: [
              "hermes",
              "chat",
              "--tui",
              "--profile",
              "default",
            ],
          },
        },
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
