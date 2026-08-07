import { describe, expect, it } from "vitest";
import {
  HARNESS_KIMI_ENABLED,
  HARNESS_MUSE_ENABLED,
  HARNESS_PRIME_AGENT_ENABLED,
  managedHarnessEnabled,
} from "../src/shared/features";
import {
  HARNESS_IDS,
  allTemplates,
} from "../src/shared/managed-terminal-templates";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";
import { SHIP_FEATURES } from "../src/shared/feature-catalog";
import { resolveBuildFeatures } from "../scripts/build-features";

describe("experimental harness product gates", () => {
  it("ship profile defaults kimi/muse/prime-agent off", () => {
    const ship = resolveBuildFeatures({});
    expect(ship.profile).toBe("ship");
    expect(ship.features.harnessKimi).toBe(false);
    expect(ship.features.harnessMuse).toBe(false);
    expect(ship.features.harnessPrimeAgent).toBe(false);
    expect(SHIP_FEATURES.harnessKimi).toBe(false);
    expect(SHIP_FEATURES.harnessMuse).toBe(false);
    expect(SHIP_FEATURES.harnessPrimeAgent).toBe(false);
  });

  it("durable vocabulary still lists gated harnesses for decode", () => {
    expect(HARNESS_IDS).toContain("kimi");
    expect(HARNESS_IDS).toContain("muse");
    expect(HARNESS_IDS).toContain("prime-agent");
    // Pi stays a production seat — not behind these gates.
    expect(HARNESS_IDS).toContain("pi");
    expect(managedHarnessEnabled("pi")).toBe(true);
  });

  it.runIf(!HARNESS_KIMI_ENABLED)("hides kimi from authoring when gated off", () => {
    expect(managedHarnessEnabled("kimi")).toBe(false);
    expect(allTemplates().map((t) => t.harness)).not.toContain("kimi");
    expect(() =>
      makeManagedAgentNode(0, 0, { harness: "kimi", host: "local" }),
    ).toThrow(/disabled/u);
  });

  it.runIf(!HARNESS_MUSE_ENABLED)("hides muse from authoring when gated off", () => {
    expect(managedHarnessEnabled("muse")).toBe(false);
    expect(allTemplates().map((t) => t.harness)).not.toContain("muse");
    expect(() =>
      makeManagedAgentNode(0, 0, { harness: "muse", host: "local" }),
    ).toThrow(/disabled/u);
  });

  it.runIf(!HARNESS_PRIME_AGENT_ENABLED)(
    "hides prime-agent from authoring when gated off",
    () => {
      expect(managedHarnessEnabled("prime-agent")).toBe(false);
      expect(allTemplates().map((t) => t.harness)).not.toContain("prime-agent");
      expect(() =>
        makeManagedAgentNode(0, 0, { harness: "prime-agent", host: "local" }),
      ).toThrow(/disabled/u);
    },
  );

  it.runIf(
    HARNESS_KIMI_ENABLED && HARNESS_MUSE_ENABLED && HARNESS_PRIME_AGENT_ENABLED,
  )("all-on restores experimental harness authoring", () => {
    expect(managedHarnessEnabled("kimi")).toBe(true);
    expect(managedHarnessEnabled("muse")).toBe(true);
    expect(managedHarnessEnabled("prime-agent")).toBe(true);
    const ids = allTemplates().map((t) => t.harness);
    expect(ids).toContain("kimi");
    expect(ids).toContain("muse");
    expect(ids).toContain("prime-agent");
  });
});
