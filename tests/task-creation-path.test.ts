import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import type { Rule, TaskRule, TasksContract } from "../src/shared/work-model";
import {
  admissionLabel,
  formatDepth,
  groupPathByDepth,
  taskPath,
} from "../src/renderer/components/rules/creation/task-path";
import {
  formatProfile,
  pathRules,
  pruneToPath,
  replaceRulesAt,
  rulesAt,
  strandedRules,
} from "../src/renderer/components/rules/creation/task-path-rules";

// Pure derivation behind the task creation path: the boards a raised task can
// travel, the rules in force at each, and board-addressed task rules.

const rule = (id: string, text = `rule ${id}`): Rule => ({ id, text });

const boardNode = (
  id: string,
  contract?: TasksContract,
  position: { x: number; y: number } = { x: 0, y: 0 },
) => ({
  id,
  type: "text" as const,
  text: id,
  x: position.x,
  y: position.y,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "task" as const },
    tasks: {
      items: [],
      ...(contract ? { contract } : {}),
    },
  },
});

const region = (
  id: string,
  label: string,
  rules: ReadonlyArray<Rule>,
  rect: { x: number; y: number; width: number; height: number },
) => ({
  id,
  type: "group" as const,
  label,
  ...rect,
  ether: { region: { contract: { rules } } },
});

const flowEdge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
  ether: { verb: "feeds" as const },
});

const doc = (nodes: ReadonlyArray<unknown>, edges: ReadonlyArray<unknown>): CanvasDoc =>
  Result.getOrThrow(decodeCanvasDoc({ nodes, edges }));

describe("taskPath", () => {
  it("walks the origin first, then Next boards breadth-first", () => {
    const board = doc(
      [boardNode("intake"), boardNode("build"), boardNode("review"), boardNode("ship")],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    const path = taskPath(board, "intake");
    expect(path.map((board) => board.nodeId)).toEqual([
      "intake",
      "build",
      "review",
      "ship",
    ]);
    expect(path.map((board) => board.depth)).toEqual([0, 1, 2, 2]);
    expect(path[0]!.origin).toBe(true);
    expect(path[1]!.origin).toBe(false);
  });

  it("marks terminals and forks", () => {
    const board = doc(
      [boardNode("intake"), boardNode("build"), boardNode("review"), boardNode("ship")],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    const path = taskPath(board, "intake");
    expect(path[1]!.destinations).toEqual(["review", "ship"]);
    expect(path[1]!.terminal).toBe(false);
    expect(path[2]!.terminal).toBe(true);
    expect(path[3]!.terminal).toBe(true);
  });

  it("keeps the shortest depth for a board reachable two ways", () => {
    const board = doc(
      [boardNode("intake"), boardNode("fast"), boardNode("slow"), boardNode("ship")],
      [
        flowEdge("e1", "intake", "fast"),
        flowEdge("e2", "intake", "slow"),
        flowEdge("e3", "fast", "ship"),
        flowEdge("e4", "slow", "ship"),
      ],
    );
    const path = taskPath(board, "intake");
    expect(path[3]!.depth).toBe(2);
  });

  it("groups a true fork without merging independent boards", () => {
    const board = doc(
      [
        boardNode("intake"),
        boardNode("left"),
        boardNode("right"),
        boardNode("left-end"),
        boardNode("right-end"),
      ],
      [
        flowEdge("e1", "intake", "left"),
        flowEdge("e2", "intake", "right"),
        flowEdge("e3", "left", "left-end"),
        flowEdge("e4", "right", "right-end"),
      ],
    );
    const stages = groupPathByDepth(taskPath(board, "intake"));
    expect(stages.map((stage) => stage.boards.map((entry) => entry.nodeId))).toEqual([
      ["intake"],
      ["left", "right"],
      ["left-end"],
      ["right-end"],
    ]);
  });

  it("terminates on a flowless board with the origin alone", () => {
    const board = doc([boardNode("solo")], []);
    const path = taskPath(board, "solo");
    expect(path).toHaveLength(1);
    expect(path[0]!.terminal).toBe(true);
  });

  it("reads the rules in force, region stack first, then the board's own", () => {
    const board = doc(
      [
        region("outer", "Factory", [rule("r1")], {
          x: -100,
          y: -100,
          width: 900,
          height: 900,
        }),
        region("inner", "Region A", [rule("r2")], {
          x: -50,
          y: -50,
          width: 400,
          height: 400,
        }),
        boardNode("build", { rules: [rule("s1")] }, { x: 0, y: 0 }),
      ],
      [],
    );
    const path = taskPath(board, "build");
    expect(path[0]!.rules.map((entry) => entry.rule.id)).toEqual([
      "r1",
      "r2",
      "s1",
    ]);
    expect(path[0]!.rules.map((entry) => entry.provenance.kind)).toEqual([
      "region",
      "region",
      "board",
    ]);
  });

  it("carries the incoming posture and admission of each board", () => {
    const board = doc(
      [
        boardNode("intake"),
        boardNode(
          "review",
          {
            instructions: "Read it against the contract.",
            incoming: {
              description: "Anything with a diff to check.",
              handling: "Triage by blast radius.",
              admission: "approval",
              waitMs: 60000,
            },
          },
        ),
      ],
      [flowEdge("e1", "intake", "review")],
    );
    const path = taskPath(board, "intake");
    expect(path[0]!.admission).toBe("auto");
    expect(path[1]).toMatchObject({
      admission: "approval",
      waitMs: 60000,
    });
  });

  it("uses the durable board name instead of the mutable task text mirror", () => {
    const source = boardNode("intake");
    const named = {
      ...source,
      text: "tasks",
      ether: {
        ...source.ether,
        tasks: { ...source.ether.tasks, name: "Intake" },
      },
    };
    expect(taskPath(doc([named], []), "intake")[0]?.label).toBe("Intake");
  });
});

describe("formatDepth and admissionLabel", () => {
  it("says the distance in words", () => {
    expect(formatDepth(0)).toBe("here");
    expect(formatDepth(1)).toBe("Next");
    expect(formatDepth(3)).toBe("3 boards on");
  });

  it("says how a board admits tasks", () => {
    expect(admissionLabel("auto")).toBe("Immediate");
    expect(admissionLabel("approval")).toBe("Approval");
    expect(admissionLabel("operator")).toBe("Me");
  });
});

const taskRule = (id: string, boardId: string): TaskRule => ({
  id,
  text: `rule ${id}`,
  board: boardId,
});

describe("task path rules", () => {
  it("reads the rules addressed to one board", () => {
    const rules = [taskRule("a", "build"), taskRule("b", "ship"), taskRule("c", "build")];
    expect(rulesAt(rules, "build").map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("replaces one board's rules and drops nothing else", () => {
    const rules = [taskRule("a", "build"), taskRule("b", "ship")];
    expect(replaceRulesAt(rules, "build", [rule("z")])).toEqual([
      taskRule("b", "ship"),
      { id: "z", text: "rule z", board: "build" },
    ]);
  });

  it("finds and prunes rules whose board left the path", () => {
    const board = doc(
      [boardNode("intake"), boardNode("build")],
      [flowEdge("e1", "intake", "build")],
    );
    const path = taskPath(board, "intake");
    const rules = [taskRule("a", "build"), taskRule("b", "gone")];
    expect(strandedRules(rules, path)).toEqual([taskRule("b", "gone")]);
    expect(pruneToPath(rules, path)).toEqual([taskRule("a", "build")]);
  });

  it("counts boards and rules in one glance", () => {
    const board = doc(
      [
        region("factory", "Factory", [rule("r1")], {
          x: -100,
          y: -100,
          width: 900,
          height: 900,
        }),
        boardNode("intake"),
        boardNode("build"),
      ],
      [flowEdge("e1", "intake", "build")],
    );
    const path = taskPath(board, "intake");
    expect(pathRules(path).map((entry) => entry.rule.id)).toEqual(["r1"]);
    expect(formatProfile(path, [taskRule("p1", "build")])).toBe("2 boards, 2 rules");
    expect(formatProfile(path)).toBe("2 boards, 1 rule");
  });
});
