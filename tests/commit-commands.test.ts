import { afterEach, describe, expect, it } from "vitest";
import { modelStore } from "../src/renderer/lib/use-model";
import { authoring } from "../src/renderer/lib/authoring";
import { openModelCanvas } from "./support/open-model-canvas";
import { note } from "./support/model-nodes";
import { asCanvasName, asNodeId, type Command } from "../src/shared/model";
import { commitCommands, redo, undo } from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

let close: (() => Promise<void>) | undefined;
const open = (...nodes: Parameters<typeof openModelCanvas>[1]) => { close = openModelCanvas("rig", nodes); };
const nodeAt = (id: string) => modelStore.node$("rig", id).peek();

const canvas = asCanvasName("rig");
const retext = (id: string, text: string): Command =>
  ({ _tag: "Edit", canvas, id: asNodeId(id), change: { kind: "note", text } }) as Command;
const textOf = (id: string): string | undefined => { const node = nodeAt(id); return node?.kind === "note" ? node.text : undefined; };
afterEach(async () => { await close?.(); state$.error.set(""); state$.saveState.set("saved"); });

describe("one act, said as commands, on typed rows", () => {
  it("applies the commands to the store and keeps the nodes it did not touch", () => {
    open(note("a", "one"), note("b", "two", { x: 300 }));
    const untouched = nodeAt("b");
    commitCommands(() => [retext("a", "edited")]);
    expect(textOf("a")).toBe("edited");
    expect(nodeAt("b")).toBe(untouched);
  });

  it("gives the writer the canvas as it stands", () => {
    open(note("a", "one"));
    let seen: ReadonlyArray<string> = [];
    commitCommands((held) => {
      seen = [...held.nodes.keys()];
      return [];
    });
    expect(seen).toEqual(["a"]);
  });

  it("is one step back and one step forward, however many commands it was", async () => {
    open(note("a", "one"), note("b", "two", { x: 300 }));
    commitCommands(() => [retext("a", "first"), retext("b", "second")]);
    expect([textOf("a"), textOf("b")]).toEqual(["first", "second"]);
    await authoring.idle();
    undo();
    await authoring.idle();
    expect([textOf("a"), textOf("b")]).toEqual(["one", "two"]);
    redo();
    await authoring.idle();
    expect([textOf("a"), textOf("b")]).toEqual(["first", "second"]);
  });

  it("is not remembered when the writer says it is not the operator's to take back", () => {
    open(note("a", "one"));
    commitCommands(() => [retext("a", "scripted")], { remember: false });
    expect(textOf("a")).toBe("scripted");
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("does nothing for no commands, and says so when the writer throws", () => {
    open(note("a", "one"));
    const held = nodeAt("a");
    commitCommands(() => []);
    expect(nodeAt("a")).toBe(held);
    commitCommands(() => {
      throw new Error("that wire would close a loop");
    });
    expect(nodeAt("a")).toBe(held);
    expect(state$.error.peek()).toContain("that wire would close a loop");
    expect(state$.saveState.peek()).toBe("error");
  });

});
