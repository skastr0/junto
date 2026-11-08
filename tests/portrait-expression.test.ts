import { describe, expect, it } from "vitest";
import { portraitCharacter, portraitConfigKey, portraitSvg, portraitGenome } from "../src/shared/agent-portrait";
import { AGENT_SIGNAL_KINDS } from "../src/shared/agent-signals";
import {
  EXPRESSION_FACES,
  PORTRAIT_EXPRESSIONS,
  portraitExpression,
  type ExpressionActivity,
  type PortraitExpression,
} from "../src/shared/portrait-expression";
import { THREAD_HEALTH_VALUES } from "../src/shared/thread-health";

const ACTIVITIES: ReadonlyArray<ExpressionActivity | undefined> = [
  undefined,
  "work",
  "call",
  "halt",
  "done",
  "live",
  "dot",
  "rest",
  "off",
];
const TEMPERAMENTS = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];
const SIGNALS = [undefined, ...AGENT_SIGNAL_KINDS];
const HEALTH = [undefined, ...THREAD_HEALTH_VALUES];

const sweep = function* () {
  for (const temperament of TEMPERAMENTS)
    for (const activity of ACTIVITIES)
      for (const signal of SIGNALS)
        for (const health of HEALTH) yield { temperament, activity, signal, health };
};

const SMILING: ReadonlySet<PortraitExpression> = new Set(["eager", "happy", "delighted", "content"]);
const UPSET: ReadonlySet<PortraitExpression> = new Set(["frustrated", "grumpy", "worried", "concerned"]);

describe("portrait expression", () => {
  it("is total over every state and reaches every expression", () => {
    const seen = new Set<PortraitExpression>();
    for (const input of sweep()) {
      const expression = portraitExpression(input);
      expect(PORTRAIT_EXPRESSIONS).toContain(expression);
      seen.add(expression);
    }
    expect([...seen].sort()).toEqual([...PORTRAIT_EXPRESSIONS].sort());
  });

  it("tells the ring's story: no smile on a blocker, no scowl on a finish", () => {
    for (const input of sweep()) {
      const expression = portraitExpression(input);
      if (input.activity === "halt" || input.signal === "blocked") expect(SMILING.has(expression)).toBe(false);
      if (input.activity === "done" && !input.signal && (!input.health || input.health === "steady")) {
        expect(UPSET.has(expression)).toBe(false);
      }
      if (input.activity === "off") expect(expression).toBe("sleepy");
    }
  });

  it("lets temperament shift the read", () => {
    expect(portraitExpression({ temperament: 1, health: "stuck" })).toBe("determined");
    expect(portraitExpression({ temperament: -1, health: "stuck" })).toBe("frustrated");
    expect(portraitExpression({ temperament: -1, activity: "rest" })).toBe("grumpy");
    expect(portraitExpression({ temperament: 0, activity: "rest" })).toBe("resting");
    expect(portraitExpression({ temperament: 1, activity: "rest" })).toBe("content");
    expect(portraitExpression({ temperament: 0, activity: "work" })).toBe("focused");
    expect(portraitExpression({ temperament: 0, activity: "work", health: "exceeding" })).toBe("delighted");
    expect(portraitExpression({ temperament: 0, activity: "call" })).toBe("curious");
    expect(portraitExpression({ temperament: 0, activity: "done" })).toBe("content");
    expect(portraitExpression({ temperament: Number.NaN, activity: "work" })).toBe("focused");
  });

  it("puts signals and trouble ahead of the activity", () => {
    expect(portraitExpression({ temperament: 0, activity: "work", signal: "blocked" })).toBe("concerned");
    expect(portraitExpression({ temperament: 0, activity: "work", health: "thrashing" })).toBe("worried");
    expect(portraitExpression({ temperament: 0, activity: "done", signal: "escalate" })).toBe("curious");
  });
});

describe("portrait customization", () => {
  it("resting face and empty config are the identity portrait", () => {
    for (const seed of ["a", "b", "node-7"]) {
      const plain = portraitSvg({ seed, mode: "dark", detail: "card" });
      expect(portraitSvg({ seed, mode: "dark", detail: "card", config: {}, face: EXPRESSION_FACES.resting })).toBe(plain);
    }
  });

  it("every expression renders distinctly from rest", () => {
    const rest = portraitSvg({ seed: "a", mode: "bright", detail: "card", face: EXPRESSION_FACES.resting });
    for (const expression of PORTRAIT_EXPRESSIONS.filter((e) => e !== "resting")) {
      expect(portraitSvg({ seed: "a", mode: "bright", detail: "card", face: EXPRESSION_FACES[expression] })).not.toBe(rest);
    }
  });

  it("overrides lay over the genome and ignore unknown values", () => {
    const genome = portraitGenome("a");
    const custom = portraitCharacter("a", { shape: "toast", topper: "cat", bodyHue: "violet", temperament: 3 });
    expect(custom.shape).toBe("toast");
    expect(custom.topper).toBe("cat");
    expect(custom.bodyHue).toBe("violet");
    expect(custom.temperament).toBe(1);
    expect(custom.gaze).toBe(genome.gaze);
    const junk = portraitCharacter("a", { shape: "nope" as never, bodyHue: "crimson" });
    expect(junk.shape).toBe(genome.shape);
    expect(junk.bodyHue).toBe(genome.bodyHue);
  });

  it("keys configs stably regardless of field order", () => {
    expect(portraitConfigKey({ shape: "toast", eyes: "dot" })).toBe(portraitConfigKey({ eyes: "dot", shape: "toast" }));
    expect(portraitConfigKey(undefined)).toBe("");
  });
});
