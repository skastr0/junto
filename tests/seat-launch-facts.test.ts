import { describe, expect, it } from "vitest";
import type { HarnessParamSpec } from "../src/shared/harness-domain";
import { HARNESS_RECORDS } from "../src/shared/harness-records";
import { resolveManagedLaunch, type ManagedLaunchChoices } from "../src/shared/managed-terminal-launch";
import { HARNESS_IDS, templateFor, type HarnessId } from "../src/shared/managed-terminal-templates";
import type { Seat } from "../src/shared/model";
import {
  HARNESS_DEFAULT,
  seatLaunchFacts,
  tallyLaunchConfigurations,
  type SeatLaunchFact,
} from "../src/shared/seat-launch-facts";

type Launch = NonNullable<Seat["launch"]>;

/** A seat launched the way seatParts launches one, without its build gate. */
const seatOn = (
  harness: HarnessId,
  choices: ManagedLaunchChoices = {},
  extra: { readonly id?: string; readonly host?: string; readonly agentKey?: string } = {},
) => {
  const resolved = resolveManagedLaunch(harness, { cwd: "/Users/me/Projects/junto", ...choices }, {});
  const launch: Launch = {
    kind: "harness",
    argv: resolved.argv ?? [],
    ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
    ...(resolved.env && Object.keys(resolved.env).length > 0 ? { env: { ...resolved.env } } : {}),
    ...(choices.extraArgs && choices.extraArgs.length > 0 ? { extraArgs: [...choices.extraArgs] } : {}),
  };
  const host = extra.host ?? "studio";
  return {
    id: extra.id ?? `seat-${harness}`,
    harness,
    host,
    agentKey: extra.agentKey ?? `${host}:${harness}`,
    launch,
  };
};

/** A value each declared dial takes and the launch emits, so it can be read back. */
const valueFor = (spec: HarnessParamSpec): string | undefined => {
  switch (spec.key) {
    case "model":
      return "test-model";
    case "provider":
      return "openrouter";
    case "profile":
      return "worker";
    case "effort":
      return spec.options.source === "fixed" ? spec.options.values.at(-1) : undefined;
    case "mode":
      return spec.options.source === "fixed" && spec.options.values.length > 0 ? spec.options.values.at(-1) : "plan";
    case "permissionMode": {
      if (spec.emit.via === "switch") return spec.emit.value;
      if (spec.emit.via === "perValue") {
        const argv = spec.emit.argv;
        return Object.keys(argv).find((value) => (argv[value]?.length ?? 0) > 0);
      }
      if (spec.options.source === "fixed") {
        return spec.options.values.find((value) => value !== spec.defaultValue && !spec.unoffered?.includes(value));
      }
      return "custom-permission";
    }
    case "extraArgs":
      return undefined;
  }
};

const byKey = (facts: readonly SeatLaunchFact[]) => new Map(facts.map((fact) => [fact.key, fact]));

describe("seatLaunchFacts: what a seat runs, read from its launch", () => {
  for (const harness of HARNESS_IDS) {
    const params = HARNESS_RECORDS[harness].params.params;
    const declared = params.filter((spec) => spec.key !== "extraArgs");

    it(`${harness}: a seat that sets nothing reads harness default for every dial it declares`, () => {
      const facts = seatLaunchFacts(seatOn(harness));
      const keys = facts.map((fact) => fact.key);
      expect(facts[0]).toEqual({ key: "harness", label: "Harness", value: templateFor(harness).displayName });
      for (const spec of declared) {
        expect(byKey(facts).get(spec.key)).toEqual({
          key: spec.key,
          label: spec.label,
          value: HARNESS_DEFAULT,
          harnessDefault: true,
        });
      }
      // Nothing it does not declare, no extra arguments it was not given.
      expect(keys).toEqual(["harness", ...orderOf(declared.map((spec) => spec.key)), "machine", "folder"]);
      expect(byKey(facts).get("machine")?.value).toBe("studio");
      expect(byKey(facts).get("folder")?.value).toBe("/Users/me/Projects/junto");
    });

    it(`${harness}: a seat that sets every dial reads each value back`, () => {
      const choices: Record<string, string> = {};
      for (const spec of declared) {
        const value = valueFor(spec);
        if (value !== undefined) choices[spec.key] = value;
      }
      const facts = byKey(seatLaunchFacts(seatOn(harness, choices)));
      const slugEffort = declared.some((spec) => spec.key === "effort" && spec.emit.via === "modelSlug");
      for (const spec of declared) {
        const value = choices[spec.key];
        if (value === undefined) continue;
        if (slugEffort && (spec.key === "effort" || spec.key === "model")) {
          // The effort rides inside the model id: the model fact carries both.
          expect(facts.has("effort")).toBe(false);
          expect(facts.get("model")?.value).toBe(`${choices.model}-${choices.effort}`);
          continue;
        }
        expect(facts.get(spec.key), `${harness} ${spec.key}`).toEqual({ key: spec.key, label: spec.label, value });
      }
    });
  }

  it("dials come first, then profile and provider, extra arguments, machine and folder", () => {
    const facts = seatLaunchFacts(
      seatOn("hermes", { profile: "worker", provider: "openrouter", model: "big", extraArgs: ["--verbose"] }),
      { machine: (host) => (host === "studio" ? "Studio Mac" : host) },
    );
    const keys = facts.map((fact) => fact.key);
    expect(keys.indexOf("profile")).toBeGreaterThan(keys.indexOf("model"));
    expect(keys.indexOf("provider")).toBeGreaterThan(keys.indexOf("profile"));
    expect(byKey(facts).get("extraArgs")).toEqual({ key: "extraArgs", label: "Extra arguments", value: "--verbose" });
    expect(keys.slice(-2)).toEqual(["machine", "folder"]);
    expect(byKey(facts).get("machine")?.value).toBe("Studio Mac");
  });

  it("a profile the launch does not carry is read from the agent key", () => {
    const facts = byKey(seatLaunchFacts(seatOn("hermes", {}, { agentKey: "studio:reviewer" })));
    expect(facts.get("profile")).toEqual({ key: "profile", label: "Profile", value: "reviewer" });
  });

  it("a seat with no launch reads harness default and no folder", () => {
    const facts = seatLaunchFacts({ harness: "claude", host: "studio", agentKey: "studio:claude" });
    expect(byKey(facts).get("model")?.harnessDefault).toBe(true);
    expect(byKey(facts).has("folder")).toBe(false);
  });
});

/** The declared dials in the order seatLaunchFacts gives them. */
const orderOf = (keys: readonly string[]): readonly string[] => [
  ...keys.filter((key) => key !== "profile" && key !== "provider"),
  ...["profile", "provider"].filter((key) => keys.includes(key)),
];

describe("tallyLaunchConfigurations: the selected seats by how they launch", () => {
  it("groups seats that launch the same way, whatever machine or folder they are on", () => {
    const tally = tallyLaunchConfigurations([
      seatOn("claude", { model: "opus", effort: "xhigh" }, { id: "a" }),
      seatOn("claude", { model: "opus", effort: "xhigh", cwd: "/elsewhere" }, { id: "b", host: "mini" }),
      seatOn("claude", { model: "opus", effort: "high" }, { id: "c" }),
      seatOn("pi", {}, { id: "d" }),
    ]);
    expect(tally.map(({ summary, count, seatIds }) => ({ summary, count, seatIds }))).toEqual([
      { summary: "Claude Code, opus, xhigh", count: 2, seatIds: ["a", "b"] },
      { summary: "Claude Code, opus, high", count: 1, seatIds: ["c"] },
      { summary: `${templateFor("pi").displayName}, harness defaults`, count: 1, seatIds: ["d"] },
    ]);
  });

  it("a dial set to a value is a different launch from the same dial left unset", () => {
    const tally = tallyLaunchConfigurations([
      seatOn("codex", { model: "gpt-5" }, { id: "a" }),
      seatOn("codex", {}, { id: "b" }),
    ]);
    expect(tally).toHaveLength(2);
  });
});
