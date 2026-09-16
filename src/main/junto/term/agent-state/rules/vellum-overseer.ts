import type { SeatRulePack } from "../types";

/** Exact OSC title states emitted by our own native controller. No terminal composer. */
export const juntoOverseerRules: SeatRulePack = {
  harness: "vellum-overseer", version: "1",
  rules: [
    { id: "controller_working", state: "working", priority: 100, region: "osc_title", visibleWorking: true,
      matchers: { regex: ["^Junto Overseer working$"] } },
    { id: "controller_idle", state: "idle", priority: 100, region: "osc_title", visibleIdle: true,
      matchers: { regex: ["^Junto Overseer idle$"] } },
    { id: "controller_attention", state: "attention", priority: 100, region: "osc_title", visibleAttention: true,
      matchers: { regex: ["^Junto Overseer attention$"] } },
  ],
};
