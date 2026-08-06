import { describe, expect, it } from "vitest";
import {
  evaluateFinishCriteria,
  normalizeCompletionEvidence,
  normalizeFinishCriteria,
} from "../src/shared/finish-criteria";
import type { Artifact, Task } from "../src/shared/work-model";

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    state: "working",
    claimedBy: "seat_" + "a".repeat(64),
    history: [
      {
        messageId: "m1",
        role: "user",
        parts: [{ kind: "text", text: "do it" }],
      },
    ],
    ...over,
  }) as Task;

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  artifactId: "a1",
  name: "report",
  parts: [{ kind: "text", text: "body" }],
  task: {
    kind: "task",
    itemId: "t1",
    sink: { canvasName: "board", nodeId: "tasks" },
  },
  ...over,
});

describe("finish criteria", () => {
  it("normalizes empty criteria to undefined", () => {
    expect(normalizeFinishCriteria({})).toBeUndefined();
    expect(normalizeFinishCriteria(undefined)).toBeUndefined();
  });

  it("normalizes git minCommits and artifacts", () => {
    expect(
      normalizeFinishCriteria({
        description: " ship it ",
        artifacts: {
          nodeId: " art1 ",
          names: [" report ", "report", ""],
        },
        git: { minCommits: 2.9 },
      }),
    ).toEqual({
      description: "ship it",
      artifacts: { nodeId: "art1", names: ["report"] },
      git: { minCommits: 2 },
    });
  });

  it("passes when no criteria", () => {
    expect(
      evaluateFinishCriteria({
        task: baseTask(),
        taskNodeId: "tasks",
        canvasName: "board",
        evidence: undefined,
        artifactsByNode: new Map(),
      }),
    ).toBeUndefined();
  });

  it("rejects complete without artifacts when required", () => {
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: { artifacts: { nodeId: "art1" } },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: { artifacts: [] },
      artifactsByNode: new Map(),
    });
    expect(fail?.missing).toBe("artifacts");
  });

  it("accepts linked artifact citation + git", () => {
    const art = artifact();
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: {
          artifacts: { nodeId: "art1", names: ["report"] },
          git: { minCommits: 1 },
        },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: normalizeCompletionEvidence({
        artifacts: [{ artifactId: "a1", nodeId: "art1" }],
        git: { commits: ["3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345"] },
      }),
      artifactsByNode: new Map([["art1", [art]]]),
    });
    expect(fail).toBeUndefined();
  });

  it("rejects git evidence that is not a real object id format", () => {
    const art = artifact();
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: { git: { minCommits: 1 } },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: normalizeCompletionEvidence({
        artifacts: [],
        git: { commits: ["abc123", "xyz"] },
      }),
      artifactsByNode: new Map([["art1", [art]]]),
    });
    expect(fail?.missing).toBe("git.sha_format");
  });

  it("rejects duplicate git evidence padding the count", () => {
    const art = artifact();
    const dupes = ["3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345", "3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345"];
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: { git: { minCommits: 2 } },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: normalizeCompletionEvidence({ artifacts: [], git: { commits: dupes } }),
      artifactsByNode: new Map([["art1", [art]]]),
    });
    expect(fail?.missing).toBe("git.commits");
  });

  it("rejects unlinked artifact", () => {
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: { artifacts: { nodeId: "art1" } },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: {
        artifacts: [{ artifactId: "a1", nodeId: "art1" }],
      },
      artifactsByNode: new Map([
        ["art1", [artifact({ task: undefined })]],
      ]),
    });
    expect(fail?.missing).toBe("artifacts.taskLink");
  });

  it("rejects missing git commits", () => {
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: { git: { minCommits: 1 } },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: { artifacts: [], git: { commits: [] } },
      artifactsByNode: new Map(),
    });
    expect(fail?.missing).toBe("git.commits");
  });

  it("description-only criteria never hard-gates", () => {
    expect(
      evaluateFinishCriteria({
        task: baseTask({
          finishCriteria: { description: "looks good" },
        }),
        taskNodeId: "tasks",
        canvasName: "board",
        evidence: undefined,
        artifactsByNode: new Map(),
      }),
    ).toBeUndefined();
  });

  it("rejects exact name case mismatch", () => {
    const fail = evaluateFinishCriteria({
      task: baseTask({
        finishCriteria: {
          artifacts: { nodeId: "art1", names: ["Report"] },
        },
      }),
      taskNodeId: "tasks",
      canvasName: "board",
      evidence: {
        artifacts: [{ artifactId: "a1", nodeId: "art1" }],
      },
      artifactsByNode: new Map([["art1", [artifact({ name: "report" })]]]),
    });
    expect(fail?.missing).toBe("artifacts.names");
  });
});
