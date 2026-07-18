import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  makeCanvasExternalReloadCoordinator,
  type ExternalCanvasRead,
} from "../src/renderer/lib/canvas-external-reload";

const doc = (text: string): CanvasDoc => ({
  nodes: [{ id: "note", type: "text", text, x: 0, y: 0, width: 120, height: 60 }],
  edges: [],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
};

describe("canvas external reload ordering", () => {
  it("never lets an older disk read roll back a newer notification", async () => {
    let name = "alpha";
    let revision = "r0";
    let epoch = 0;
    let current = doc("base");
    const reads: Array<ReturnType<typeof deferred<ExternalCanvasRead>>> = [];
    const apply = vi.fn((result: ExternalCanvasRead) => {
      name = result.name;
      revision = result.revision;
      epoch += 1;
      current = result.doc;
    });
    const coordinator = makeCanvasExternalReloadCoordinator({
      flushLocalEdits: async () => undefined,
      readCanvas: async () => {
        const read = deferred<ExternalCanvasRead>();
        reads.push(read);
        return read.promise;
      },
      currentCanvasName: () => name,
      currentDoc: () => current,
      currentDocEpoch: () => epoch,
      currentRevision: () => revision,
      hasPendingChanges: () => false,
      acceptRevision: (_canvasName, nextRevision) => {
        revision = nextRevision;
      },
      apply,
      onFailure: (error) => {
        throw error;
      },
    });

    const older = coordinator.changed("alpha");
    await waitFor(() => reads.length === 1);
    const newer = coordinator.changed("alpha");
    await waitFor(() => reads.length === 2);

    reads[1]!.resolve({ name: "alpha", doc: doc("newer"), revision: "r2" });
    await newer;
    expect(current).toEqual(doc("newer"));
    expect(revision).toBe("r2");

    reads[0]!.resolve({ name: "alpha", doc: doc("older"), revision: "r1" });
    await older;
    expect(current).toEqual(doc("newer"));
    expect(revision).toBe("r2");
    expect(apply).toHaveBeenCalledOnce();
  });

  it("rejects a disk result when the local document identity changes in flight", async () => {
    let revision = "r0";
    let epoch = 0;
    let current = doc("base");
    const read = deferred<ExternalCanvasRead>();
    const apply = vi.fn((result: ExternalCanvasRead) => {
      revision = result.revision;
      epoch += 1;
      current = result.doc;
    });
    const coordinator = makeCanvasExternalReloadCoordinator({
      flushLocalEdits: async () => undefined,
      readCanvas: async () => read.promise,
      currentCanvasName: () => "alpha",
      currentDoc: () => current,
      currentDocEpoch: () => epoch,
      currentRevision: () => revision,
      hasPendingChanges: () => false,
      acceptRevision: (_canvasName, nextRevision) => {
        revision = nextRevision;
      },
      apply,
      onFailure: (error) => {
        throw error;
      },
    });

    const pending = coordinator.changed("alpha");
    await Promise.resolve();
    epoch += 1;
    current = doc("local-edit");
    read.resolve({ name: "alpha", doc: doc("external"), revision: "external-r1" });
    await pending;

    expect(apply).not.toHaveBeenCalled();
    expect(current).toEqual(doc("local-edit"));
    expect(revision).toBe("r0");
  });
});
