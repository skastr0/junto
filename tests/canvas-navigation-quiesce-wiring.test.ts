import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("canvas navigation quiesce wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/renderer/App.tsx"), "utf8");

  it("admits and drains open navigation as one authoring operation", () => {
    const start = source.indexOf("const openCanvas = async");
    const end = source.indexOf("const nodeRefNavigation", start);
    const block = source.slice(start, end);

    expect(block).toContain("runCanvasAuthoringOperation(async () =>");
    // The canvas is read first; the latch is checked after the read and
    // before anything of it is put on screen.
    const read = block.indexOf("await readHeld(name)");
    const gate = block.indexOf("canvasMutationsQuiesced()", read);
    const shown = block.indexOf("showHeld(name, held)");
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(read);
    expect(gate).toBeLessThan(shown);
  });

  it("checks node-ref admission before any partial canvas or selection update", () => {
    const coordinatorStart = source.indexOf("const nodeRefNavigation");
    const coordinatorEnd = source.indexOf("const createCanvas = async", coordinatorStart);
    const coordinator = source.slice(coordinatorStart, coordinatorEnd);
    const listenerStart = source.indexOf("junto.onNodeRefOpened");
    const listenerEnd = source.indexOf("// Usage:", listenerStart);
    const listener = source.slice(listenerStart, listenerEnd);

    expect(coordinator).toContain("assertCanApply: assertCanvasNavigationAdmitted");
    expect(coordinator.indexOf("assertCanApply: assertCanvasNavigationAdmitted"))
      .toBeLessThan(coordinator.indexOf("showHeld("));
    expect(listener).toContain("runCanvasAuthoringOperation(async () =>");
    expect(listener.indexOf("assertCanvasNavigationAdmitted()"))
      .toBeLessThan(listener.indexOf("nodeRefNavigation.navigate(event)"));
    expect(listener).not.toContain("if (canvasMutationsQuiesced()) return");
  });

  it("does not apply returning create/delete continuations after the latch", () => {
    const createStart = source.indexOf("const createCanvas = async");
    const deleteStart = source.indexOf("const deleteCanvas = async", createStart);
    const retryStart = source.indexOf("const retryActionForError", deleteStart);
    const create = source.slice(createStart, deleteStart);
    const remove = source.slice(deleteStart, retryStart);

    const createCall = create.indexOf('await window.junto.modelCommand({ _tag: "CreateCanvas"');
    const gateAfterCreate = create.indexOf("if (canvasMutationsQuiesced()) return", createCall);
    expect(createCall).toBeLessThan(gateAfterCreate);
    expect(gateAfterCreate)
      .toBeLessThan(create.indexOf("showHeld(result.name, held)"));
    expect(remove.indexOf('await window.junto.modelCommand({ _tag: "RemoveCanvas"'))
      .toBeLessThan(remove.lastIndexOf("if (canvasMutationsQuiesced()) return"));
    expect(remove.lastIndexOf("if (canvasMutationsQuiesced()) return"))
      .toBeLessThan(remove.indexOf("await openCanvas(remaining[0]!.name)"));
  });
});
