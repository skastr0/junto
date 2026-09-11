import { describe, expect, it } from "vitest";
import type { Artifact, Task } from "../src/shared/canvas";
import type { TaskRef } from "../src/shared/work-reference";
import {
  artifactDeletionWarning,
  artifactSearchText,
  artifactTaskReferenceLabel,
  taskDisplayTitle,
} from "../src/renderer/components/work/artifact-reference";

const linked: Artifact = {
  artifactId: "artifact-1",
  name: "release proof",
  parts: [{ kind: "text", text: "done" }],
  task: {
    kind: "task",
    itemId: "task-1",
    sink: {
      canvasName: "factory",
      nodeId: "tasks-remote",
    },
  },
};

const brief = (messageId: string, text: string) => ({
  messageId,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
});

const gatingTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
    state: "working",
    history: [brief("m1", "Ship the release proof\nwith details")],
    finishCriteria: {
      artifacts: { nodeId: "artifacts-shelf" },
    },
    ...overrides,
  }) as Task;

const resolveFrom = (tasks: ReadonlyArray<Task>) => (ref: TaskRef) =>
  ref.sink.canvasName === "factory"
    ? tasks.find((task) => task.id === ref.itemId)
    : undefined;

const warningFor = (artifact: Artifact, tasks: ReadonlyArray<Task>) =>
  artifactDeletionWarning({
    artifact,
    sinkNodeId: "artifacts-shelf",
    resolveTask: resolveFrom(tasks),
  });

describe("artifact TaskRef presentation", () => {
  it("renders the item and its complete sink identity", () => {
    expect(artifactTaskReferenceLabel(linked)).toBe(
      "Task #task-1 - factory/tasks-remote",
    );
  });

  it("indexes every independently useful TaskRef component", () => {
    const indexed = artifactSearchText(linked).toLowerCase();
    for (const query of [
      "release proof",
      "artifact-1",
      "task-1",
      "factory",
      "tasks-remote",
      "factory/tasks-remote",
    ]) {
      expect(indexed).toContain(query);
    }
  });

  it("omits status when the artifact has no task link (never says Unbound)", () => {
    expect(
      artifactTaskReferenceLabel({
        artifactId: "artifact-standalone",
        parts: [{ kind: "text", text: "standalone" }],
      }),
    ).toBeNull();
  });
});

describe("taskDisplayTitle", () => {
  it("prefers the authored title over the brief", () => {
    expect(
      taskDisplayTitle({
        ...gatingTask(),
        metadata: { title: "Cut the release" },
      }),
    ).toBe("Cut the release");
  });

  it("falls back to the brief first line, then the task id", () => {
    expect(taskDisplayTitle(gatingTask())).toBe("Ship the release proof");
    expect(
      taskDisplayTitle(gatingTask({ history: [] })),
    ).toBe("task-1");
  });
});

describe("artifactDeletionWarning", () => {
  it("warns when an unfinished task gates on this sink with no name constraint", () => {
    expect(warningFor(linked, [gatingTask()])).toBe(
      "This artifact can provide completion evidence for unfinished task “Ship the release proof”. Deleting it may require publishing and citing a replacement.",
    );
  });

  it("warns when the gate names this artifact (trimmed match)", () => {
    const tasks = [
      gatingTask({
        finishCriteria: {
          artifacts: { nodeId: "artifacts-shelf", names: ["release proof"] },
        },
      }),
    ];
    expect(warningFor({ ...linked, name: " release proof " }, tasks)).toBe(
      "This artifact can provide completion evidence for unfinished task “Ship the release proof”. Deleting it may require publishing and citing a replacement.",
    );
  });

  it("stays silent on a case-sensitive name mismatch", () => {
    expect(
      warningFor(linked, [
        gatingTask({
          finishCriteria: {
            artifacts: { nodeId: "artifacts-shelf", names: ["Release Proof"] },
          },
        }),
      ]),
    ).toBeNull();
  });

  it("stays silent for an unlinked artifact", () => {
    expect(
      warningFor(
        { artifactId: "artifact-2", name: "loose", parts: [] },
        [gatingTask()],
      ),
    ).toBeNull();
  });

  it("stays silent when the referenced task no longer exists", () => {
    expect(warningFor(linked, [])).toBeNull();
  });

  it("stays silent for a terminal task", () => {
    expect(warningFor(linked, [gatingTask({ state: "completed" })])).toBeNull();
  });

  it("stays silent when the gate points at another artifacts sink", () => {
    expect(
      warningFor(linked, [
        gatingTask({
          finishCriteria: { artifacts: { nodeId: "artifacts-elsewhere" } },
        }),
      ]),
    ).toBeNull();
  });

  it("stays silent when the gate names a different artifact", () => {
    expect(
      warningFor(linked, [
        gatingTask({
          finishCriteria: {
            artifacts: { nodeId: "artifacts-shelf", names: ["changelog"] },
          },
        }),
      ]),
    ).toBeNull();
  });

  it("stays silent when the artifact has no name and the gate names artifacts", () => {
    expect(
      warningFor(
        { ...linked, name: undefined },
        [
          gatingTask({
            finishCriteria: {
              artifacts: { nodeId: "artifacts-shelf", names: ["release proof"] },
            },
          }),
        ],
      ),
    ).toBeNull();
  });

  it("resolves TaskRefs only within the named canvas", () => {
    expect(
      warningFor(
        { ...linked, task: { ...linked.task!, sink: { canvasName: "other", nodeId: "tasks-remote" } } },
        [gatingTask()],
      ),
    ).toBeNull();
  });
});
