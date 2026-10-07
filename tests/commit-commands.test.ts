import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { asCanvasName, asNodeId, type Command } from "../src/shared/model";
import { commitCommands, loadDoc, redo, undo } from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

// No `window.junto` and no open canvas in the store: the commands are applied
// to the document itself, which is what a rig of a writer asserts on.

const note = (id: string, text: string, x = 0): CanvasNode =>
  ({ id, type: "text", text, x, y: 0, width: 200, height: 80 }) as CanvasNode;
const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });
const canvas = asCanvasName("rig");
const retext = (id: string, text: string): Command =>
  ({ _tag: "Edit", canvas, id: asNodeId(id), change: { kind: "note", text } }) as Command;
const textOf = (id: string): string | undefined => {
  const node = state$.doc.peek().nodes.find((candidate) => candidate.id === id);
  return node?.type === "text" ? node.text : undefined;
};

afterEach(() => {
  state$.error.set("");
  state$.saveState.set("saved");
});

describe("one act, said as commands, with nothing to send it to", () => {
  it("applies the commands to the document and keeps the nodes it did not touch", () => {
    state$.canvasName.set("rig");
    loadDoc(doc(note("a", "one"), note("b", "two", 300)), undefined, "rig");
    const untouched = state$.doc.peek().nodes.find((node) => node.id === "b");
    commitCommands(() => [retext("a", "edited")]);
    expect(textOf("a")).toBe("edited");
    expect(state$.doc.peek().nodes.find((node) => node.id === "b")).toBe(untouched);
  });

  it("gives the writer the canvas as it stands", () => {
    state$.canvasName.set("rig");
    loadDoc(doc(note("a", "one")), undefined, "rig");
    let seen: ReadonlyArray<string> = [];
    commitCommands((held) => {
      seen = [...held.nodes.keys()];
      return [];
    });
    expect(seen).toEqual(["a"]);
  });

  it("is one step back and one step forward, however many commands it was", () => {
    state$.canvasName.set("rig");
    loadDoc(doc(note("a", "one"), note("b", "two", 300)), undefined, "rig");
    commitCommands(() => [retext("a", "first"), retext("b", "second")]);
    expect([textOf("a"), textOf("b")]).toEqual(["first", "second"]);
    undo();
    expect([textOf("a"), textOf("b")]).toEqual(["one", "two"]);
    redo();
    expect([textOf("a"), textOf("b")]).toEqual(["first", "second"]);
  });

  it("is not remembered when the writer says it is not the operator's to take back", () => {
    state$.canvasName.set("rig");
    loadDoc(doc(note("a", "one")), undefined, "rig");
    commitCommands(() => [retext("a", "scripted")], { remember: false });
    expect(textOf("a")).toBe("scripted");
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("does nothing for no commands, and says so when the writer throws", () => {
    state$.canvasName.set("rig");
    loadDoc(doc(note("a", "one")), undefined, "rig");
    const held = state$.doc.peek();
    commitCommands(() => []);
    expect(state$.doc.peek()).toBe(held);
    commitCommands(() => {
      throw new Error("that wire would close a loop");
    });
    expect(state$.doc.peek()).toBe(held);
    expect(state$.error.peek()).toContain("that wire would close a loop");
    expect(state$.saveState.peek()).toBe("error");
  });

  it("does nothing on a Remote station", () => {
    state$.canvasName.set("rig");
    loadDoc(doc(note("a", "one")), undefined, "rig");
    const role = state$.settings.station.role.peek();
    state$.settings.station.role.set("remote");
    try {
      commitCommands(() => [retext("a", "from a remote")]);
      expect(textOf("a")).toBe("one");
    } finally {
      state$.settings.station.role.set(role);
    }
  });
});
