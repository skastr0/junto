import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type ClosedTaskLayer, type TaskId, type TaskView } from "../src/shared/task-model";
import type { CompletionEvidence } from "../src/shared/work-model";
import { evidenceGroups, hasEvidence, shortCommit } from "../src/renderer/components/tasks/task-evidence-model";
import { TaskEvidence } from "../src/renderer/components/tasks/TaskEvidence";
import { TaskLayers } from "../src/renderer/components/tasks/TaskLayers";
import { SelectedTask } from "../src/renderer/components/tasks/TasksNode";

const evidence: CompletionEvidence = {
  artifacts: [
    { artifactId: "a1", nodeId: "artifacts-x" },
    { artifactId: "a2", nodeId: "artifacts-y" },
    { artifactId: "a1", nodeId: "artifacts-x" },
    { artifactId: "a3", nodeId: "artifacts-x" },
  ],
  git: { commits: ["0123456789abcdef", "fedcba9876543210"] },
  claims: [{ ruleId: "r1", text: "Tests run green" }],
  waivers: [{ ruleId: "r2", reason: "No docs on this board" }],
};

describe("evidence model", () => {
  it("groups cited artifacts by node, once each, in order first cited", () => {
    expect(evidenceGroups(evidence)).toEqual([
      { nodeId: "artifacts-x", artifactIds: ["a1", "a3"] },
      { nodeId: "artifacts-y", artifactIds: ["a2"] },
    ]);
  });

  it("shortens a commit and knows when a finish left nothing", () => {
    expect(shortCommit("0123456789abcdef")).toBe("0123456");
    expect(hasEvidence(undefined, undefined)).toBe(false);
    expect(hasEvidence({ artifacts: [] }, "  ")).toBe(false);
    expect(hasEvidence({ artifacts: [] }, "Handed over")).toBe(true);
    expect(hasEvidence({ artifacts: [], git: { commits: ["abc"] } }, undefined)).toBe(true);
    expect(hasEvidence({ artifacts: [], waivers: [{ ruleId: "r", reason: "x" }] }, undefined)).toBe(true);
  });
});

describe("TaskEvidence", () => {
  it("draws nothing when a finish left nothing", () => {
    expect(renderToStaticMarkup(<TaskEvidence canvasName="c" evidence={{ artifacts: [] }} />)).toBe("");
  });

  it("shows the handoff, the cited artifacts as chips, short commits, claims and waivers", () => {
    const html = renderToStaticMarkup(<TaskEvidence canvasName="c" evidence={evidence} handoff="Over to QA, the tabs are done." />);
    expect(html).toContain("Over to QA, the tabs are done.");
    expect(html).toContain("Artifacts cited");
    expect((html.match(/data-kind="artifact"/g) ?? []).length).toBe(3);
    expect(html).toContain(">0123456<");
    expect(html).toContain(">fedcba9<");
    expect(html).toContain("Tests run green");
    expect(html).toContain("Waived: No docs on this board");
  });
});

describe("evidence in the pane", () => {
  const board = taskNodeId(asNodeId("tasks-build"));
  const qa = taskNodeId(asNodeId("tasks-qa"));
  const view = (over: Partial<TaskView["current"]> = {}, layers: ReadonlyArray<ClosedTaskLayer> = []): TaskView => ({
    taskId: mintItemId() as TaskId,
    number: 3 as TaskView["number"],
    title: "Ship it",
    current: { state: "in-review", node: board, assignee: seatNodeId(asNodeId("seat-ada")), epoch: 0, stampPolicy: { required: 1 }, reviewers: [], stamps: [], ...over },
    layers,
    dependsOn: [],
    createdAt: 1,
    updatedAt: 1,
    stateSince: 1,
  });
  const draw = (v: TaskView) =>
    renderToStaticMarkup(
      <SelectedTask
        canvasName="c"
        view={v}
        all={[v]}
        seats={[]}
        facts={{ downstream: () => [], stampDefaultOf: () => ({ required: 0 }), seatReaches: () => true }}
        nodeName={() => "Build board"}
        seatName={() => "Ada"}
        now={10_000}
        error={null}
        apply={async () => undefined}
      />,
    );

  it("shows what the task in review carries, and nothing for a task that carries none", () => {
    expect(draw(view({ evidence, handoff: "Ready for you" }))).toContain("Ready for you");
    expect(draw(view())).not.toContain('data-testid="task-evidence"');
  });

  it("shows what a closed layer left, under its row", () => {
    const layer: ClosedTaskLayer = {
      state: "done",
      node: qa,
      epoch: 0,
      stampPolicy: { required: 0 },
      reviewers: [],
      stamps: [],
      evidence: { artifacts: [], git: { commits: ["deadbeefcafe"] } },
      handoff: "QA is green",
      closedAt: 5_000,
    };
    const html = renderToStaticMarkup(
      <TaskLayers canvasName="c" layers={[layer]} nodeName={() => "QA board"} seats={[]} now={10_000} />,
    );
    expect(html).toContain("Left on QA board");
    expect(html).toContain("QA is green");
    expect(html).toContain(">deadbee<");
  });
});
