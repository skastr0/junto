import { describe, expect, it, vi } from "vitest";
import type { CanvasReadResult, NodeRefOpenedEvent } from "../src/shared/ipc";
import { formatNodeRef } from "../src/shared/node-ref";
import {
  makeNavigationClock,
  makeNodeRefNavigationCoordinator,
  type NodeRefNavigationError,
} from "../src/renderer/lib/node-ref-navigation";

const textNode = (id: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
});

const canvas = (name: string, nodeIds: ReadonlyArray<string>): CanvasReadResult => ({
  name,
  doc: { nodes: nodeIds.map(textNode), edges: [] },
  actorRefs: [],
  revision: `${name}-revision`,
});

const event = (canvasName: string, nodeId: string): NodeRefOpenedEvent => ({
  ref: formatNodeRef({ canvasName, nodeId }),
  canvasName,
  nodeId,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("renderer Vellum node-reference navigation", () => {
  it("re-reads the addressed canvas and applies one exact node", async () => {
    const apply = vi.fn();
    const coordinator = makeNodeRefNavigationCoordinator({
      clock: makeNavigationClock(),
      readCanvas: async (name) => canvas(name, ["page"]),
      apply,
    });
    const target = event("portfolio", "page");

    await expect(coordinator.navigate(target)).resolves.toBeUndefined();

    expect(coordinator.hasReceived()).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(target, canvas("portfolio", ["page"]));
  });

  it.each([
    { nodeIds: [] as ReadonlyArray<string>, code: "missing" },
    { nodeIds: ["page", "page"] as ReadonlyArray<string>, code: "duplicate" },
  ])("rejects a $code node without applying stale selection", async ({ nodeIds, code }) => {
    const apply = vi.fn();
    const onFailure = vi.fn();
    const coordinator = makeNodeRefNavigationCoordinator({
      clock: makeNavigationClock(),
      readCanvas: async () => canvas("portfolio", nodeIds),
      apply,
      onFailure,
    });

    await expect(coordinator.navigate(event("portfolio", "page"))).rejects.toMatchObject({ code });
    expect(apply).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("rejects malformed events and read failures for durable replay", async () => {
    const apply = vi.fn();
    const failures: NodeRefNavigationError[] = [];
    const coordinator = makeNodeRefNavigationCoordinator({
      clock: makeNavigationClock(),
      readCanvas: async () => {
        throw new Error("unreadable");
      },
      apply,
      onFailure: (error) => failures.push(error),
    });

    await expect(
      coordinator.navigate({ ...event("portfolio", "page"), ref: "vellum://canvas/portfolio?node=%70age" }),
    ).rejects.toEqual(expect.objectContaining({ code: "event" }));
    await expect(coordinator.navigate(event("portfolio", "page"))).rejects.toEqual(
      expect.objectContaining({ code: "read" }),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(failures.map((error) => error.code)).toEqual(["event", "read"]);
  });

  it("rejects for durable replay when authoring quiesces during the async read", async () => {
    const read = deferred<CanvasReadResult>();
    const apply = vi.fn();
    let admitted = true;
    const coordinator = makeNodeRefNavigationCoordinator({
      clock: makeNavigationClock(),
      readCanvas: () => read.promise,
      assertCanApply: () => {
        if (!admitted) throw new Error("renderer quiesced");
      },
      apply,
    });

    const navigation = coordinator.navigate(event("portfolio", "page"));
    admitted = false;
    read.resolve(canvas("portfolio", ["page"]));

    await expect(navigation).rejects.toMatchObject({ code: "apply" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("lets the latest async reference win and acknowledges the obsolete read", async () => {
    const alpha = deferred<CanvasReadResult>();
    const applied: string[] = [];
    const coordinator = makeNodeRefNavigationCoordinator({
      clock: makeNavigationClock(),
      readCanvas: (name) =>
        name === "alpha" ? alpha.promise : Promise.resolve(canvas("beta", ["newer"])),
      apply: (target) => applied.push(target.ref),
    });

    const older = coordinator.navigate(event("alpha", "older"));
    const newerTarget = event("beta", "newer");
    await expect(coordinator.navigate(newerTarget)).resolves.toBeUndefined();
    alpha.resolve(canvas("alpha", ["older"]));
    await expect(older).resolves.toBeUndefined();

    expect(applied).toEqual([newerTarget.ref]);
  });

  it("lets a newer invalid delivery supersede an older slow read", async () => {
    const slow = deferred<CanvasReadResult>();
    const apply = vi.fn();
    const coordinator = makeNodeRefNavigationCoordinator({
      clock: makeNavigationClock(),
      readCanvas: () => slow.promise,
      apply,
    });

    const older = coordinator.navigate(event("alpha", "older"));
    await expect(
      coordinator.navigate({ ...event("beta", "newer"), nodeId: "substituted" }),
    ).rejects.toMatchObject({ code: "event" });
    slow.resolve(canvas("alpha", ["older"]));
    await expect(older).resolves.toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it("allows a newer ordinary canvas navigation to supersede a pending reference", async () => {
    const slow = deferred<CanvasReadResult>();
    const clock = makeNavigationClock();
    const apply = vi.fn();
    const coordinator = makeNodeRefNavigationCoordinator({
      clock,
      readCanvas: () => slow.promise,
      apply,
    });

    const pending = coordinator.navigate(event("portfolio", "page"));
    clock.begin();
    slow.reject(new Error("obsolete read failure"));

    await expect(pending).resolves.toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });
});
