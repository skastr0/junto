/**
 * A Hermes profile name has one shape wherever it goes: listed by the scan,
 * carried on the link's inventory snapshot, and passed to `hermes --profile`.
 * A name that cannot cross cannot launch.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeLinkInventorySnapshot, inventoryOfSnapshot, wireSnapshot } from "../src/main/junto/inventory/wire";
import { HARNESS_PROFILE_LISTS } from "../src/main/junto/term/templates/enumerate-dispatch";
import { launchForManagedSpawn, SeatProfileRefused } from "../src/main/junto/term/managed-spawn-plan";
import { agentKeyProfileSuffix, profileFromAgentKey } from "../src/shared/harness-records";
import type { HarnessInventory } from "../src/shared/harness-domain/inventory";
import { parseAgentKey, parseHermesProfileName } from "../src/main/junto/hermes/domain";

const BAD = ["-x", "--config", "../etc", "a:b", "a.b", "a/b", "a b", "ä", "x".repeat(65)];

describe("hermes profile names", () => {
  it("lists names only from the profile table", () => {
    const table = [
      "Profile          Model      Gateway   ",
      "──────────────────────────────────────",
      "◆default         gpt-5.5    running   —  —",
      "research         sonnet     stopped   —  —",
    ].join("\n");
    expect(HARNESS_PROFILE_LISTS.hermes?.parse(table)).toEqual(["default", "research"]);
    expect(HARNESS_PROFILE_LISTS.hermes?.args).toEqual(["profile", "list"]);
  });

  it("carries fitting names on the wire and leaves the rest out, never rewritten", () => {
    const row: HarnessInventory = {
      harness: "hermes", machine: "mini", installed: true, models: [], efforts: [], refreshing: false,
      profiles: ["default", "research", ...BAD, "research"],
    };
    const { snapshot, omittedProfiles } = wireSnapshot({ machine: "mini", harnesses: [row] }, 1);
    expect(snapshot.harnesses[0]?.profiles).toEqual(["default", "research"]);
    expect(omittedProfiles).toBe(BAD.length + 1);
    expect(inventoryOfSnapshot(decodeLinkInventorySnapshot(JSON.parse(JSON.stringify(snapshot)))).harnesses[0]?.profiles)
      .toEqual(["default", "research"]);

    for (const name of BAD) {
      const bad = { ...snapshot, harnesses: [{ ...snapshot.harnesses[0]!, profiles: [name] }] };
      expect(() => decodeLinkInventorySnapshot(bad), name).toThrow();
    }
    const tooMany = { ...snapshot, harnesses: [{ ...snapshot.harnesses[0]!, profiles: Array.from({ length: 65 }, (_, i) => `p${i}`) }] };
    expect(() => decodeLinkInventorySnapshot(tooMany)).toThrow();
  });

  it("reads no profile from an agent key whose suffix is not a name", () => {
    expect(profileFromAgentKey("hermes", "mini:research")).toBe("research");
    expect(profileFromAgentKey("hermes", "mini:hermes")).toBeUndefined();
    for (const name of BAD) {
      expect(profileFromAgentKey("hermes", `mini:${name}`), name).toBeUndefined();
      expect(agentKeyProfileSuffix("hermes", `mini:${name}`), name).toBe(name.trim());
    }
  });

  it("refuses to launch a seat whose profile is not a name, rather than starting the default", () => {
    const documentLaunch = { kind: "harness" as const, argv: ["hermes", "chat", "--tui"] };
    expect(launchForManagedSpawn({ nodeId: "w", harness: "hermes", agentKey: "mini:research", documentLaunch }).launch?.argv)
      .toEqual(expect.arrayContaining(["--profile", "research"]));
    for (const name of BAD.filter((entry) => entry.trim() === entry)) {
      expect(() => launchForManagedSpawn({ nodeId: "w", harness: "hermes", agentKey: `mini:${name}`, documentLaunch }), name)
        .toThrow(SeatProfileRefused);
      expect(() => launchForManagedSpawn({ nodeId: "w", harness: "hermes", agentKey: "mini:hermes", profile: name, documentLaunch }), name)
        .toThrow(SeatProfileRefused);
    }
  });

  it("refuses as a tagged failure that encodes like the rest", () => {
    const refused = (() => {
      try { launchForManagedSpawn({ nodeId: "w", harness: "hermes", agentKey: "mini:-x", documentLaunch: { kind: "harness", argv: ["hermes"] } }); }
      catch (cause) { return cause; }
    })();
    expect(refused).toMatchObject({ _tag: "SeatProfileRefused", harness: "hermes" });
    expect(Schema.encodeSync(SeatProfileRefused)(refused as SeatProfileRefused)).toMatchObject({ _tag: "SeatProfileRefused", harness: "hermes" });
  });

  it("holds the ACP path to the same shape, so a profile is never a flag to hermes -p", () => {
    expect(parseHermesProfileName("research")).toBe("research");
    expect(parseAgentKey("mini:research")).toEqual({ host: "mini", profile: "research" });
    for (const name of BAD) {
      expect(parseHermesProfileName(name), name).toBeUndefined();
      expect(parseAgentKey(`mini:${name}`), name).toBeUndefined();
    }
  });
});
