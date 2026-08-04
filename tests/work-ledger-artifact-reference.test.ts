import { describe, expect, it } from "vitest";
import type { Artifact } from "../src/shared/canvas";
import {
  artifactSearchText,
  artifactTaskReferenceLabel,
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

  it("labels unbound artifacts honestly", () => {
    expect(
      artifactTaskReferenceLabel({
        artifactId: "artifact-unbound",
        parts: [{ kind: "text", text: "standalone" }],
      }),
    ).toBe("Unbound output");
  });
});
