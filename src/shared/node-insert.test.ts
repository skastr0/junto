import { describe, expect, it } from "vitest";
import {
  decodeEffectTasksCreate,
  defaultEffectTasksCreate,
  effectTasksCreateToWorkArgs,
} from "./node-insert";

describe("effect payloads (closed create contracts)", () => {
  it("decodes EffectTasksCreate and rejects missing description", () => {
    const ok = decodeEffectTasksCreate({
      brief: "Ship",
      metadata: { title: "Ship", details: "Full description" },
      reason: "scheduler",
    });
    expect(ok.ok).toBe(true);
    const bad = decodeEffectTasksCreate({
      brief: "Ship",
      metadata: { title: "Ship" },
    });
    expect(bad.ok).toBe(false);
    const excess = decodeEffectTasksCreate({
      brief: "Ship",
      metadata: { details: "x" },
      invented: true,
    });
    expect(excess.ok).toBe(false);
  });

  it("maps validated payload to work create args", () => {
    const decoded = decodeEffectTasksCreate({
      brief: "Ship",
      metadata: { title: "Ship", details: "Do the thing" },
      finishCriteria: { description: "done", git: { minCommits: 1 } },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const args = effectTasksCreateToWorkArgs(decoded.value);
    expect(args.brief).toBe("Ship");
    expect(args.metadata.details).toBe("Do the thing");
    expect(args.finishCriteria).toEqual({
      description: "done",
      git: { minCommits: 1 },
    });
  });

  it("the provenance-built default is schema-valid on its own", () => {
    const task = defaultEffectTasksCreate("cron");
    expect(decodeEffectTasksCreate(task).ok).toBe(true);
    expect(task.reason).toBeUndefined();
  });
});
