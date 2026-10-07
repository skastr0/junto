import { ulid } from "ulid";
import { createAuthoring } from "./model-authoring";
import { modelStore } from "./use-model";

// The window's one authoring: every edit of what is on a canvas goes through
// `authoring.act`, and undo and redo through it too. An edit is worked out by
// model-edits.ts against `modelStore.canvasOf(canvas)` and handed here.

export const authoring = createAuthoring(modelStore, () => ({
  // A reseat is undone into a new session, which needs a binding of its own.
  newBinding: () => ulid(),
}));
