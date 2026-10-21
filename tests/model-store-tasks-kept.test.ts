/**
 * A command that puts a seat back answers how many of its tasks stayed in the
 * backlog (seat-release.ts); the store passes that on to whoever listens.
 */
import { describe, expect, it } from "vitest";
import { asCanvasName, asNodeId, type Command } from "../src/shared/model";
import { createModelStore, type ModelApi } from "../src/renderer/lib/model-store";

const storeAnswering = (tasksKept?: number) =>
  createModelStore((): ModelApi => ({
    modelOpen: () => Promise.reject(new Error("not opened here")),
    modelCommand: () => Promise.resolve(tasksKept === undefined ? { seq: 1 } : { seq: 1, tasksKept }),
    onModelChanged: () => () => {},
  }));

const removal: Command = { _tag: "Remove", canvas: asCanvasName("factory"), nodes: [asNodeId("ada")], wires: [] };

describe("tasks a restored seat could not take back", () => {
  it("are told to the listeners, with the canvas", async () => {
    const store = storeAnswering(2);
    const heard: Array<[string, number]> = [];
    const stop = store.onTasksKept((canvas, count) => heard.push([canvas, count]));
    await store.deliver(removal, false);
    stop();
    await store.deliver(removal, false);
    expect(heard).toEqual([["factory", 2]]);
  });

  it("are not told when every task went back", async () => {
    const store = storeAnswering();
    const heard: number[] = [];
    store.onTasksKept((_canvas, count) => heard.push(count));
    await store.deliver(removal, false);
    expect(heard).toEqual([]);
  });
});
