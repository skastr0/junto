/**
 * Quick capture's Inbox (0.11.2, 11 Q4): the one Artifacts node of a canvas
 * the operator's captures land in. The operator picks it in Settings or on
 * their first Cmd+T; "Make an Inbox" places a new Artifacts node at the
 * canvas's edge and sets it.
 *
 * Machine-local view state (`view_capture_inboxes`), read synchronously from
 * the load snapshot. It goes with its node and its canvas, so a node deleted
 * leaves the canvas without an Inbox and the next Cmd+T asks again.
 */
import { modelStore } from "./use-model";
import { flushPendingCanvasSave, addNode, renameNode } from "./mutations";
import { newArtifacts } from "./model-factories";
import { topZ } from "./model-edits";
import { state$ } from "./state";
import { nodeViewStore, useNodeView } from "./node-view-state";

export const INBOX_NAME = "Inbox";

/** Space kept between the canvas's farthest node and the Inbox placed beside it. */
const EDGE_GAP = 80;

/** The canvas's Inbox node id, or undefined while none is set. */
export const captureInboxOf = (canvas: string): string | undefined => nodeViewStore().captureInbox(canvas);

/** The same, read again whenever it changes. */
export const useCaptureInbox = (canvas: string): string | undefined =>
  useNodeView((store) => store.captureInbox(canvas));

/** Choose the Inbox, or null to forget it so the next capture asks again. */
export const setCaptureInbox = (canvas: string, node: string | null): void => {
  nodeViewStore().writeCaptureInbox(canvas, node);
};

/**
 * Where a new node of this size goes so it sits past the canvas's last node:
 * at the left edge of what is there, below it. An empty canvas gets the origin.
 */
export const edgeSpot = (
  nodes: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>,
): { readonly x: number; readonly y: number } => {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const left = Math.min(...nodes.map((node) => node.x));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { x: left, y: bottom + EDGE_GAP };
};

/**
 * Add an Artifacts node named Inbox past the canvas's edge, set it as the
 * Inbox once main holds it, and answer its id. Only the canvas this window
 * shows can be added to. The Inbox is written after main has taken the node:
 * the store keeps a row only for a node that exists.
 */
export const makeCaptureInbox = async (canvas: string): Promise<string> => {
  if (state$.canvasName.peek() !== canvas) throw new Error(`canvas "${canvas}" is not the one in front of you`);
  const held = modelStore.canvasOf(canvas);
  const spot = edgeSpot([...held.nodes.values()]);
  const node = newArtifacts({ ...spot, z: topZ(held) });
  addNode(node, { edit: false, focus: false });
  renameNode(node.id, INBOX_NAME);
  await flushPendingCanvasSave();
  setCaptureInbox(canvas, node.id);
  return node.id;
};
