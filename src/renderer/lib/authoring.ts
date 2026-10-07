import { ulid } from "ulid";
import type { Command, NodeId } from "@shared/model";
import { sheetStore } from "./sheet-store";
import { createAuthoring } from "./model-authoring";
import { modelStore } from "./use-model";

// The window's one authoring: every edit of what is on a canvas goes through
// `authoring.act`, and undo and redo through it too. An edit is worked out by
// model-edits.ts against `modelStore.canvasOf(canvas)` and handed here.

type SheetWrite = Extract<Command, { readonly _tag: "WriteSheet" }>;
const sheetWrites = (command: Command): ReadonlyArray<SheetWrite> =>
  command._tag === "WriteSheet" ? [command] : command._tag === "Batch" ? command.steps.flatMap(sheetWrites) : [];

export const authoring = createAuthoring({
  canvasOf: modelStore.canvasOf,
  show: (command) => {
    // Authoring captured the old grid first. Every reader now sees the write,
    // including an undo or redo, before main acknowledges it.
    for (const write of sheetWrites(command)) sheetStore.show(write.canvas, write.id, write.grid);
    return modelStore.show(command);
  },
  deliver: async (command, shown) => {
    try {
      await modelStore.deliver(command, shown);
    } catch (error) {
      for (const write of sheetWrites(command)) sheetStore.reread(write.canvas, write.id);
      throw error;
    }
  },
}, (canvas) => {
  // This snapshot must survive later optimistic writes while main is busy.
  const sheets = new Map([...modelStore.canvasOf(canvas).nodes.values()]
    .filter((node) => node.kind === "sheet")
    .map((node) => [node.id, sheetStore.gridOf(canvas, node.id)]));
  return {
    sheetOf: (id) => sheets.get(id as NodeId),
    // A reseat is undone into a new session, which needs a binding of its own.
    newBinding: () => ulid(),
  };
});
