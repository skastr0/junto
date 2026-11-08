import { describe, expect, it } from "vitest";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";
import { resolveTarget, typedTargetOf } from "../src/shared/target-resolution";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId } from "../src/shared/physics/schema";
import type { TargetCandidate } from "../src/shared/work-control";
import { ItemId, TaskNumber } from "../src/shared/work-ids";

const TASK = ItemId.make("01M5ESS4R68EVCEB1K7Y9GTQX6");
const OTHER = ItemId.make("01M5ESS4R68EVCEB1K7Y9GTQX7");

const candidates: ReadonlyArray<TargetCandidate> = [
  { kind: "agent", nodeId: asNodeId("lead"), name: "cli-lead" },
  { kind: "agent", nodeId: asNodeId("twin-a"), name: "helper" },
  { kind: "agent", nodeId: asNodeId("twin-b"), name: "Helper" },
  { kind: "task", nodeId: asNodeId("board"), name: "Board" },
  { kind: "task", nodeId: asNodeId("board"), itemId: TASK, name: "fix tabs", number: TaskNumber.make(42) },
];
const kinds = new Map<string, NodeKind>([
  ["lead", "agent"],
  ["twin-a", "agent"],
  ["twin-b", "agent"],
  ["board", "task"],
  ["far", "agent"],
]);
const resolve = (typed: string) => resolveTarget({ typed, candidates, kindOf: (id) => kinds.get(id) });

describe("node ref item", () => {
  it("formats and parses a node ref with and without an item", () => {
    const plain = formatNodeRef({ canvasName: "factory", nodeId: "task-1" });
    expect(plain).toBe("junto://canvas/factory?node=task-1");
    expect(parseNodeRef(plain)).toEqual({ ok: true, value: { canvasName: "factory", nodeId: "task-1" } });

    const item = formatNodeRef({ canvasName: "factory", nodeId: "task-1", itemId: TASK });
    expect(item).toBe(`junto://canvas/factory?node=task-1&item=${TASK}`);
    expect(parseNodeRef(item)).toEqual({ ok: true, value: { canvasName: "factory", nodeId: "task-1", itemId: TASK } });
  });

  it("refuses any other query shape, and an item that is not a ULID", () => {
    for (const bad of [
      `junto://canvas/factory?item=${TASK}&node=task-1`,
      `junto://canvas/factory?node=task-1&item=${TASK}&x=1`,
      "junto://canvas/factory?node=task-1&other=1",
      "junto://canvas/factory?node=task-1&",
    ]) {
      const parsed = parseNodeRef(bad);
      expect(parsed.ok).toBe(false);
    }
    const lower = parseNodeRef(`junto://canvas/factory?node=task-1&item=${TASK.toLowerCase()}`);
    expect(lower.ok === false && lower.error.code).toBe("item_id");
  });
});

describe("target resolution", () => {
  it("classifies a ref, a task number and a word", () => {
    expect(typedTargetOf(`junto://canvas/old-name?node=board&item=${TASK}`)).toEqual({
      ok: true,
      typed: { kind: "ref", nodeId: "board", itemId: TASK },
    });
    for (const typed of [" #42 ", "42"]) {
      expect(typedTargetOf(typed)).toEqual({ ok: true, typed: { kind: "number", number: 42 } });
    }
    expect(typedTargetOf("#0")).toEqual({ ok: true, typed: { kind: "word", text: "#0" } });
    expect(typedTargetOf("T-42")).toEqual({ ok: true, typed: { kind: "word", text: "T-42" } });
    expect(typedTargetOf("cli-lead")).toEqual({ ok: true, typed: { kind: "word", text: "cli-lead" } });
    expect(typedTargetOf("junto://canvas/factory?node=")).toMatchObject({ ok: false });
  });

  it("resolves an id, a name ignoring case, a ref by node and item, and a task number", () => {
    expect(resolve("lead")).toEqual({ ok: true, target: { nodeId: "lead" } });
    expect(resolve("  CLI-Lead ")).toEqual({ ok: true, target: { nodeId: "lead" } });
    // The canvas comes from context: a ref from before a rename still resolves.
    expect(resolve(`junto://canvas/old-name?node=board&item=${OTHER}`)).toEqual({
      ok: true,
      target: { nodeId: "board", itemId: OTHER },
    });
    expect(resolve("#42")).toEqual({ ok: true, target: { nodeId: "board", itemId: TASK } });
  });

  it("passes an id or a ref to an existing node on for admission, even outside the candidates", () => {
    expect(resolve("far")).toEqual({ ok: true, target: { nodeId: "far" } });
    expect(resolve("junto://canvas/factory?node=far")).toEqual({ ok: true, target: { nodeId: "far" } });
  });

  it("refuses a shared name listing the matches, and no match listing every candidate", () => {
    const twins = resolve("HELPER");
    expect(twins.ok === false && twins.reason).toBe("ambiguous");
    expect(twins.ok === false && twins.reason === "ambiguous" && twins.candidates.map((c) => c.nodeId)).toEqual([
      "twin-a",
      "twin-b",
    ]);
    for (const typed of ["nobody", "#7", "junto://canvas/factory?node=gone", "fix tabs"]) {
      const none = resolve(typed);
      expect(none.ok === false && none.reason).toBe("none");
      expect(none.ok === false && none.reason === "none" && none.candidates).toEqual(candidates);
    }
    expect(resolve("junto://canvas/factory?node=")).toMatchObject({ ok: false, reason: "malformed" });
    // A seat holds no items: an item on its ref is refused, as the mention contract refuses it.
    expect(resolve(`junto://canvas/factory?node=lead&item=${TASK}`)).toMatchObject({ ok: false, reason: "malformed" });
  });
});
