import { expect, launchJunto, test } from "../harness/launch";
import type { CanvasName, NodeId, Changed } from "../../src/shared/model";

test("opens model rows and receives committed deltas without spatial sheet contents", async () => {
  const junto = await launchJunto({ offline: true, seedCanvases: { proof: { nodes: [], edges: [] } } });
  try {
    const result = await junto.page.evaluate(async () => {
      const api = window.junto;
      if (!api) throw new Error("Junto preload is unavailable");
      const canvasName = "model-proof" as CanvasName;
      const noteId = "proof-note" as NodeId;
      const sheetId = "proof-sheet" as NodeId;
      const events: Changed[] = [];
      const sheets: unknown[] = [];
      const stop = api.onModelChanged((event) => events.push(event));
      const stopSheets = api.onModelSheetChanged((event) => sheets.push(event));
      try {
        await api.modelCommand({ _tag: "CreateCanvas", canvas: canvasName });
        const initial = await api.modelOpen({ canvas: canvasName });
        const frame = { x: 0, y: 0, width: 200, height: 90, z: 0 };
        const added = await api.modelCommand({ _tag: "Add", canvas: canvasName, nodes: [
          { ...frame, id: noteId, kind: "note", text: "before" },
          { ...frame, id: sheetId, kind: "sheet" },
        ], wires: [] });
        const edited = await api.modelCommand({ _tag: "Edit", canvas: canvasName, id: noteId, change: { kind: "note", text: "after" } });
        const grid = { columns: [{ id: "c", name: "Value" }], rows: [{ id: "r", cells: { c: "123" } }] };
        await api.modelCommand({ _tag: "WriteSheet", canvas: canvasName, id: sheetId, grid });
        const current = await api.modelOpen({ canvas: canvasName });
        const storedGrid = await api.modelSheetRead({ canvas: canvasName, id: sheetId });
        const refs = await api.modelActorRefs({ canvas: canvasName });
        // An IPC reply follows the commit; queued notifications must also arrive.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return { initial, added, edited, current, storedGrid, grid, refs, events, sheets };
      } finally { stop(); stopSheets(); }
    });
    expect(result.initial).toEqual({ canvas: "model-proof", seq: 0, nodes: [], wires: [] });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ canvas: "model-proof", seq: result.added.seq, nodes: expect.any(Array) });
    expect(result.events[1]).toMatchObject({ seq: result.edited.seq, nodes: [{ id: "proof-note", text: "after" }], wires: [], removedNodes: [], removedWires: [] });
    expect(result.current.nodes.find((node) => node.kind === "sheet")).not.toHaveProperty("rows");
    expect(result.storedGrid).toEqual(result.grid);
    expect(result.sheets).toEqual([{ canvas: "model-proof", id: "proof-sheet" }]);
    expect(result.refs).toEqual([]);
  } finally { await junto.close(); }
});
