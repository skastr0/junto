import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
  type CanvasNode,
  type TextNode,
} from "../src/shared/canvas";
import { mergeAuthorialCanvas } from "../src/shared/authorial-canvas-merge";
import { taskItem } from "./helpers/task-fixtures";

const node = (id: string, text = id): TextNode => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 120,
  height: 60,
});

const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

const merged = (base: CanvasDoc, local: CanvasDoc, remote: CanvasDoc): CanvasDoc => {
  const result = mergeAuthorialCanvas(base, local, remote);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected clean merge");
  return result.doc;
};

describe("authorial canvas three-way merge", () => {
  it("round-trips optional overseer seat metadata", () => {
    const source = doc({
      ...node("agent"),
      ether: {
        entity: { kind: "agent", name: "local:builder" },
        terminal: { bindingId: "seat-1", harness: "codex" },
        overseer: true,
      },
    });
    const decoded = Result.getOrThrow(decodeCanvasDoc(JSON.parse(serializeCanvas(source))));
    expect(decoded.nodes[0]?.ether?.overseer).toBe(true);
  });

  it("merges disjoint fields, membership, and edges from both authors", () => {
    const base = doc(node("a"), node("b"));
    const local: CanvasDoc = {
      nodes: [
        { ...node("a"), x: 80 },
        node("b"),
        node("local-add"),
      ],
      edges: [{ id: "local-edge", fromNode: "a", toNode: "local-add" }],
    };
    const remote: CanvasDoc = {
      nodes: [
        node("a", "renamed remotely"),
        node("b"),
        node("remote-add"),
      ],
      edges: [{ id: "remote-edge", fromNode: "b", toNode: "remote-add" }],
    };

    const result = merged(base, local, remote);
    expect(result.nodes.find((entry) => entry.id === "a")).toMatchObject({
      x: 80,
      text: "renamed remotely",
    });
    expect(result.nodes.map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "local-add",
      "remote-add",
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["local-edge", "remote-edge"]);
  });

  it("reports same-field and deletion-vs-edit races instead of choosing a winner", () => {
    const base = doc(node("same"), node("deleted-locally"), node("deleted-remotely"));
    const local = doc(
      node("same", "local"),
      { ...node("deleted-remotely"), x: 10 },
    );
    const remote = doc(
      node("same", "remote"),
      { ...node("deleted-locally"), x: 20 },
    );

    const result = mergeAuthorialCanvas(base, local, remote);
    expect(result).toEqual({
      ok: false,
      conflicts: [
        { object: "node", id: "same", path: "text", kind: "field" },
        { object: "node", id: "deleted-remotely", path: "", kind: "delete-vs-edit" },
        { object: "node", id: "deleted-locally", path: "", kind: "delete-vs-edit" },
      ],
    });
  });

  it("takes overseer only from current main authority and strips it from local copies", () => {
    const seat = {
      ...node("seat"),
      ether: {
        entity: { kind: "agent", name: "local:builder" },
        terminal: { bindingId: "seat-1", harness: "codex" as const },
      },
    };

    const granted = merged(
      doc(seat),
      doc({ ...seat, x: 50 }),
      doc({ ...seat, ether: { ...seat.ether, overseer: true } }),
    );
    expect(granted.nodes[0]).toMatchObject({ x: 50, ether: { overseer: true } });

    const revoked = merged(
      doc({ ...seat, ether: { ...seat.ether, overseer: true } }),
      doc({ ...seat, x: 75, ether: { ...seat.ether, overseer: true } }),
      doc(seat),
    );
    expect(revoked.nodes[0]?.ether?.overseer).toBeUndefined();

    const copied = merged(
      doc(),
      doc({ ...seat, id: "copy", ether: { ...seat.ether, overseer: true } }),
      doc(),
    );
    expect(copied.nodes[0]?.ether?.overseer).toBeUndefined();

    const reseated = merged(
      doc({ ...seat, ether: { ...seat.ether, overseer: true } }),
      doc({
        ...seat,
        ether: {
          ...seat.ether,
          terminal: { ...seat.ether.terminal, bindingId: "seat-2" },
          overseer: true,
        },
      }),
      doc({ ...seat, ether: { ...seat.ether, overseer: true } }),
    );
    expect(reseated.nodes[0]?.ether?.terminal?.bindingId).toBe("seat-2");
    expect(reseated.nodes[0]?.ether?.overseer).toBeUndefined();

    const ordinaryConfig = merged(
      doc({ ...seat, ether: { ...seat.ether, overseer: true } }),
      doc({ ...seat, text: "Renamed", ether: { ...seat.ether, overseer: false } }),
      doc({ ...seat, ether: { ...seat.ether, overseer: true } }),
    );
    expect(ordinaryConfig.nodes[0]).toMatchObject({
      text: "Renamed",
      ether: { overseer: true },
    });

    const implicitHostChange = merged(
      doc({
        ...seat,
        ether: {
          ...seat.ether,
          entity: { kind: "agent", name: "remote-a:builder" },
          overseer: true,
        },
      }),
      doc({
        ...seat,
        ether: {
          ...seat.ether,
          entity: { kind: "agent", name: "remote-b:builder" },
          overseer: true,
        },
      }),
      doc({
        ...seat,
        ether: {
          ...seat.ether,
          entity: { kind: "agent", name: "remote-a:builder" },
          overseer: true,
        },
      }),
    );
    expect(implicitHostChange.nodes[0]?.ether?.overseer).toBeUndefined();
  });

  it("merges authored task name and contract with the latest Work projection", () => {
    const task: TextNode = {
      ...node("tasks", "queued"),
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [],
          name: "Backlog",
          contract: { instructions: "Old instructions" },
        },
      },
    };
    const local = doc({
      ...task,
      x: 40,
      ether: {
        ...task.ether,
        tasks: {
          items: [],
          name: "Intake",
          contract: { instructions: "Triage before claim" },
        },
      },
    });
    const remote = doc({
      ...task,
      text: "working",
      ether: {
        ...task.ether,
        tasks: {
          items: [taskItem("t1", "working", "working")],
          name: "Backlog",
          contract: { instructions: "Old instructions" },
        },
      },
    });

    const result = merged(doc(task), local, remote);
    expect(result.nodes[0]).toMatchObject({
      x: 40,
      text: "working",
      ether: {
        tasks: {
          items: [{ id: "t1", state: "working" }],
          name: "Intake",
          contract: { instructions: "Triage before claim" },
        },
      },
    });
  });
});
