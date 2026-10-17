import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CAPABILITIES,
  CommandSupport,
  HARNESS_SIGNAL_KINDS,
  SignalSupport,
} from "../src/shared/harness-domain";
import {
  HARNESS_CAPABILITIES,
  HARNESS_CAPABILITY_DECLARATIONS,
  harnessCapabilitiesFor,
  type CapabilityGround,
} from "../src/shared/harness-capabilities";
import {
  HARNESS_FOLLOW_UP,
  HARNESS_IDS,
  templateFor,
  type HarnessId,
} from "../src/shared/managed-terminal-templates";
import { rulePackFor } from "../src/main/junto/term/agent-state/rules";

const sorted = (keys: readonly string[]): string[] => [...keys].sort();

/** Does the ground resolve to a real rule, template fact or file today? */
const resolves = (harness: HarnessId, ground: CapabilityGround): boolean => {
  if ("rule" in ground) return rulePackFor(harness).rules.some((rule) => rule.id === ground.rule);
  if ("code" in ground) return true;
  switch (ground.template) {
    case "followUp.steering":
      return HARNESS_FOLLOW_UP[harness].steering.mode === "steering";
    case "followUp.queue":
      return HARNESS_FOLLOW_UP[harness].queue !== undefined;
    case "argvSpec.resumeMode": {
      const template = templateFor(harness);
      return template.argvSpec.resumeMode !== undefined && template.capabilityBadges.sessionId !== "unavailable";
    }
  }
};

describe("harness capabilities", () => {
  it("declares a complete record for every harness", () => {
    expect(sorted(Object.keys(HARNESS_CAPABILITIES))).toEqual(sorted(HARNESS_IDS));
    for (const harness of HARNESS_IDS) {
      const record = HARNESS_CAPABILITIES[harness];
      expect(sorted(Object.keys(record.signals)), harness).toEqual(sorted(HARNESS_SIGNAL_KINDS));
      expect(sorted(Object.keys(record.commands)), harness).toEqual(sorted(COMMAND_CAPABILITIES));
      for (const support of Object.values(record.signals)) {
        expect(Schema.is(SignalSupport)(support), harness).toBe(true);
        expect(support, harness).not.toHaveProperty("grounds");
      }
      for (const support of Object.values(record.commands)) {
        expect(Schema.is(CommandSupport)(support), harness).toBe(true);
        expect(support, harness).not.toHaveProperty("grounds");
      }
    }
  });

  it("grounds every level that is not none, and every ground resolves", () => {
    for (const harness of HARNESS_IDS) {
      const declaration = HARNESS_CAPABILITY_DECLARATIONS[harness];
      const supports = [...Object.entries(declaration.signals), ...Object.entries(declaration.commands)];
      for (const [key, support] of supports) {
        if (support.level === "none") continue;
        expect(support.grounds.length, `${harness}.${key}`).toBeGreaterThan(0);
        for (const ground of support.grounds) {
          expect(resolves(harness, ground), `${harness}.${key} ${JSON.stringify(ground)}`).toBe(true);
        }
      }
    }
  });

  it("stays inside the PTY stream: screen, osc7501 and process signals, pty and process commands", () => {
    for (const harness of HARNESS_IDS) {
      const { signals, commands } = HARNESS_CAPABILITIES[harness];
      for (const support of Object.values(signals)) {
        if (support.level === "none") continue;
        expect(["screen", "osc7501", "process"], harness).toContain(support.channel);
      }
      for (const support of Object.values(commands)) {
        if (support.level === "none") continue;
        expect(["pty", "process"], harness).toContain(support.channel);
      }
    }
  });

  it("takes mail by typed Enter on every harness, steering or queued", () => {
    for (const harness of HARNESS_IDS) {
      const { commands } = HARNESS_CAPABILITIES[harness];
      const typed = { level: "typed", channel: "pty" };
      expect([commands.mailSteer, commands.mailQueue], harness).toContainEqual(typed);
      expect(commands.mailInterrupt, harness).toEqual({ level: "none" });
      if (HARNESS_FOLLOW_UP[harness].queue !== undefined) expect(commands.mailQueue, harness).toEqual(typed);
    }
    for (const harness of ["claude", "agy"] as const) {
      expect(HARNESS_CAPABILITIES[harness].commands.mailSteer, harness).toEqual({ level: "none" });
      expect(HARNESS_CAPABILITIES[harness].commands.mailQueue, harness).toEqual({ level: "typed", channel: "pty" });
    }
  });

  it("looks a harness up by id and refuses unknown ids", () => {
    expect(harnessCapabilitiesFor("claude")).toBe(HARNESS_CAPABILITIES.claude);
    expect(harnessCapabilitiesFor("not-a-harness")).toBeUndefined();
  });
});
