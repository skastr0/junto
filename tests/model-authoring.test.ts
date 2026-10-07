/**
 * Authoring: acts go out as commands and come back by undo, one at a time,
 * and a refusal from main leaves nothing remembered that is not true.
 */
import { describe, expect, it } from "vitest";
import { asCanvasName, type Command, type Node } from "../src/shared/model";
import { canvasFromOpened, type Canvas } from "../src/shared/model/canvas";
import { createAuthoring } from "../src/renderer/lib/model-authoring";
import { moved, recolored, retexted } from "../src/renderer/lib/model-edits";
import { canvasAfter } from "../src/renderer/lib/model-undo";

const name = asCanvasName("factory");
const note = (id: string, over: Record<string, unknown> = {}): Node =>
  ({ kind: "note", id, x: 10, y: 20, width: 220, height: 84, z: 0, text: "hello", ...over }) as unknown as Node;

/** A store that applies what it is sent, as main would, and can be told to refuse. */
const fakeStore = (nodes: Node[]) => {
  let canvas: Canvas = canvasFromOpened({ canvas: name, seq: 0, nodes, wires: [] });
  const sent: Command[] = [];
  let refuse: ((command: Command) => boolean) | undefined;
  let gate: Promise<void> = Promise.resolve();
  return {
    sent,
    at: (id: string) => canvas.nodes.get(id as Node["id"]),
    refuseWhen: (when: ((command: Command) => boolean) | undefined) => {
      refuse = when;
    },
    holdUntil: (until: Promise<void>) => {
      gate = until;
    },
    store: {
      canvasOf: () => canvas,
      send: async (command: Command) => {
        await gate;
        if (refuse?.(command)) throw new Error("refused");
        sent.push(command);
        canvas = canvasAfter(canvas, command);
      },
    },
  };
};

describe("authoring", () => {
  it("sends an act, and undo and redo walk it back and forward", async () => {
    const fake = fakeStore([note("plan")]);
    const authoring = createAuthoring(fake.store);
    await authoring.act(name, retexted(fake.store.canvasOf(), "plan", "one"));
    await authoring.act(name, moved(fake.store.canvasOf(), new Map([["plan", { x: 300, y: 300 }]])));
    expect(fake.at("plan")).toMatchObject({ text: "one", x: 300 });
    expect(authoring.canUndo(name)).toBe(true);

    expect(await authoring.undo(name)).toBe(true);
    expect(fake.at("plan")).toMatchObject({ text: "one", x: 10 });
    expect(await authoring.undo(name)).toBe(true);
    expect(fake.at("plan")).toMatchObject({ text: "hello", x: 10 });
    expect(await authoring.undo(name)).toBe(false);
    expect(authoring.canRedo(name)).toBe(true);

    expect(await authoring.redo(name)).toBe(true);
    expect(await authoring.redo(name)).toBe(true);
    expect(fake.at("plan")).toMatchObject({ text: "one", x: 300 });
    expect(await authoring.redo(name)).toBe(false);
  });

  it("sends nothing and remembers nothing for an act of no commands", async () => {
    const fake = fakeStore([note("plan")]);
    const authoring = createAuthoring(fake.store);
    await authoring.act(name, retexted(fake.store.canvasOf(), "plan", "hello"));
    expect(fake.sent).toEqual([]);
    expect(authoring.canUndo(name)).toBe(false);
  });

  it("does not remember an act main refuses", async () => {
    const fake = fakeStore([note("plan")]);
    const authoring = createAuthoring(fake.store);
    fake.refuseWhen(() => true);
    await expect(authoring.act(name, retexted(fake.store.canvasOf(), "plan", "one"))).rejects.toThrow("refused");
    expect(authoring.canUndo(name)).toBe(false);
  });

  it("forgets a canvas's undo when a step back is refused", async () => {
    const fake = fakeStore([note("plan")]);
    const authoring = createAuthoring(fake.store);
    await authoring.act(name, retexted(fake.store.canvasOf(), "plan", "one"));
    await authoring.act(name, retexted(fake.store.canvasOf(), "plan", "two"));
    fake.refuseWhen(() => true);
    await expect(authoring.undo(name)).rejects.toThrow("refused");
    expect(authoring.canUndo(name)).toBe(false);
    expect(authoring.canRedo(name)).toBe(false);
  });

  it("runs acts one at a time, each worked out against the canvas the one before left", async () => {
    const fake = fakeStore([note("a"), note("b", { color: "3" })]);
    const authoring = createAuthoring(fake.store);
    let open: () => void = () => undefined;
    fake.holdUntil(new Promise<void>((resolve) => {
      open = resolve;
    }));
    const first = authoring.act(name, recolored(fake.store.canvasOf(), ["a", "b"], "5"));
    const undone = authoring.undo(name);
    open();
    await first;
    expect(await undone).toBe(true);
    expect(fake.at("a")?.color).toBeUndefined();
    expect(fake.at("b")?.color).toBe("3");
  });

  it("keeps each canvas's undo apart and says when it changes", async () => {
    const fake = fakeStore([note("plan")]);
    const authoring = createAuthoring(fake.store);
    const heard: string[] = [];
    const stop = authoring.onChange((canvas) => heard.push(canvas));
    await authoring.act(name, retexted(fake.store.canvasOf(), "plan", "one"));
    expect(heard).toEqual(["factory"]);
    expect(authoring.canUndo("elsewhere")).toBe(false);
    authoring.forget(name);
    expect(authoring.canUndo(name)).toBe(false);
    expect(heard).toEqual(["factory", "factory"]);
    stop();
    await authoring.act(name, retexted(fake.store.canvasOf(), "plan", "two"));
    expect(heard).toHaveLength(2);
  });
});
