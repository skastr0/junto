import { describe, expect, it } from "vitest";
import { decodeCanvasDoc } from "./canvas";
import {
  decodeEffectBoardCreateTopic,
  decodeEffectTasksCreate,
  defaultEffectBoardCreateTopic,
  defaultEffectTasksCreate,
  effectTasksCreateToWorkArgs,
  migrateToEffectTasksCreate,
  setEffectFormValue,
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

  it("decodes board create topic contract", () => {
    expect(
      decodeEffectBoardCreateTopic({ title: "Hello", body: "world", notify: false })
        .ok,
    ).toBe(true);
    expect(decodeEffectBoardCreateTopic({ body: "no title" }).ok).toBe(false);
  });

  it("scrubs legacy brief into EffectTasksCreate on canvas load", () => {
    const result = decodeCanvasDoc({
      nodes: [
        {
          id: "c1",
          type: "text",
          text: "cron",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "cron" }, timer: { everyMinutes: 15 } },
        },
        {
          id: "t1",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "c1",
          toNode: "t1",
          ether: {
            does: {
              mode: "enqueue_task",
              brief: "old brief",
              reason: "scheduler",
            },
          },
        },
      ],
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const does = result.success.edges[0]?.ether?.does;
    expect(does?.mode).toBe("enqueue_task");
    if (does?.mode !== "enqueue_task") return;
    expect(does.data).toEqual({
      brief: "old brief",
      metadata: { title: "old brief", details: "old brief" },
      reason: "scheduler",
    });
  });

  it("form path setters stay on contract keys", () => {
    let data: Record<string, unknown> = {
      ...defaultEffectTasksCreate("relay"),
    };
    data = setEffectFormValue(data, "brief", "New title", "text");
    data = setEffectFormValue(
      data,
      "metadata.details",
      "New description",
      "textarea",
    );
    data = setEffectFormValue(data, "dependsOn", "t1, t2", "text");
    const decoded = decodeEffectTasksCreate(data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.brief).toBe("New title");
    expect(decoded.value.dependsOn).toEqual(["t1", "t2"]);
  });

  it("defaults for board and task are schema-valid and match create shape", () => {
    const task = defaultEffectTasksCreate("cron");
    expect(decodeEffectTasksCreate(task).ok).toBe(true);
    expect(task.reason).toBeUndefined();
    expect(
      decodeEffectBoardCreateTopic(defaultEffectBoardCreateTopic("cron")).ok,
    ).toBe(true);
    expect(
      migrateToEffectTasksCreate({
        mode: "enqueue_task",
        task: { title: "T", details: "D" },
      }),
    ).toMatchObject({ brief: "T", metadata: { details: "D" } });
  });

  it("git / artifact gates match TaskCreateDialog semantics", () => {
    const {
      setEffectTasksRequireGit,
      effectTasksRequireGit,
      setEffectTasksRequireArtifacts,
      effectTasksRequireArtifacts,
      setEffectTasksArtifactInstruction,
      setEffectTasksArtifactNames,
    } = require("./node-insert") as typeof import("./node-insert");
    let data: Record<string, unknown> = {
      ...defaultEffectTasksCreate("relay"),
    };
    data = setEffectTasksRequireGit(data, true);
    expect(effectTasksRequireGit(data)).toBe(true);
    expect(
      (data.finishCriteria as { git?: { minCommits: number } }).git?.minCommits,
    ).toBe(1);
    data = setEffectTasksRequireGit(data, false);
    expect(effectTasksRequireGit(data)).toBe(false);
    data = setEffectTasksRequireArtifacts(data, true, "art1");
    expect(effectTasksRequireArtifacts(data)).toBe(true);
    data = setEffectTasksArtifactInstruction(data, "publish report");
    data = setEffectTasksArtifactNames(data, "a, b");
    const decoded = decodeEffectTasksCreate(data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.finishCriteria?.artifacts).toEqual({
      nodeId: "art1",
      instruction: "publish report",
      names: ["a", "b"],
    });
  });
});
