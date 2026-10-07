import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { commitDoc, loadDoc, undo } from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

// No `window.junto` here: the window with no main to send to, as the demo
// runs. The document is then all there is.

const note = (id: string, text: string): CanvasNode =>
  ({ id, type: "text", text, x: 0, y: 0, width: 200, height: 80 }) as CanvasNode;
const seat = (id: string): CanvasNode =>
  ({
    id, type: "text", text: id, x: 40, y: 60, width: 216, height: 56,
    ether: {
      entity: { kind: "agent", name: `local:${id}` }, host: "local",
      terminal: { bindingId: `binding-${id}`, harness: "claude" },
    },
  }) as CanvasNode;
const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

afterEach(() => {
  state$.error.set("");
  state$.saveState.set("saved");
});

describe("an edit with no main to send to", () => {
  it("is shown at once and can be taken back", () => {
    state$.canvasName.set("demo");
    loadDoc(doc(note("n", "base")), undefined, "demo");
    commitDoc(doc(note("n", "edited")));
    expect(state$.doc.peek().nodes[0]).toMatchObject({ text: "edited" });
    undo();
    expect(state$.doc.peek().nodes[0]).toMatchObject({ text: "base" });
  });

  it("is refused before anything shows it when it asks for a node the canvas cannot hold", () => {
    state$.canvasName.set("demo");
    const base = doc(seat("s"), note("n", "base"));
    loadDoc(base, undefined, "demo");
    const held = state$.doc.peek();
    const epoch = state$.docEpoch.peek();
    const whole = held.nodes[0]!;
    // A seat of no size: not something the model holds.
    const sizeless = { ...whole, x: 0, y: 0, width: 0, height: 0 } as CanvasNode;
    expect(() => commitDoc(doc(sizeless, held.nodes[1]!))).not.toThrow();
    expect(state$.doc.peek()).toBe(held);
    expect(state$.docEpoch.peek()).toBe(epoch);
    expect(state$.saveState.peek()).toBe("error");
    expect(state$.error.peek()).toContain("did not take that change");
    expect(state$.error.peek()).toContain('"s"');
    expect(state$.canUndo.peek()).toBe(false);
  });
});
