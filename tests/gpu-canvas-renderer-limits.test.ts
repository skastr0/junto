// The renderer's buffers grow with the scene up to the device's own limits
// (#912): shadow tables follow the specs interned, and a buffer the device
// cannot give is reported instead of cut in silence.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, Quad } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { createRenderer } from "../src/window/canvas/engine/renderer";
import { seat } from "./support/model-nodes";

type Written = { readonly buffer: { readonly size: number }; readonly elements: number };

const fakeDevice = (limits: Record<string, number>) => {
  const writes: Written[] = [];
  const device = {
    limits,
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
    createBuffer: ({ size }: { size: number }) => ({ size, destroy: () => undefined }),
    pushErrorScope: () => undefined,
    popErrorScope: () => Promise.resolve(null),
    queue: {
      writeBuffer: (buffer: { size: number }, _offset: number, _data: unknown, _from = 0, elements = 0) => {
        writes.push({ buffer, elements });
      },
    },
  };
  return { device: device as unknown as GPUDevice, writes };
};

const shadowQuads = (count: number): Quad[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `shadow.${String(index)}`,
    kind: "shadow" as const,
    band: "cards" as const,
    z: index,
    rect: { x: 0, y: 0, width: 100, height: 60 },
    tiers: 15,
    scale: { kind: "board" as const },
    // A custom tint per quad is a new spec each: the table has no fixed size.
    style: { shadow: { name: "reach", tint: { custom: `#${index.toString(16).padStart(6, "0")}` } } },
  })) as unknown as Quad[];

const fact = (): CardFact => ({ id: "a", row: seat("a"), derived: { regionDepth: 0, blocked: false, z: 0 } });
const VIEW = { x: -100, y: -100, width: 800, height: 600 };

describe("the renderer's buffers", () => {
  it("grow the shadow tables past their first size, so every spec is written", () => {
    const scene = createScene({
      painter: () => ({ quads: shadowQuads(400), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    const prepared = scene.prepare(VIEW, "near");
    const specs = scene.shadowSnapshot().meta.length / 4;
    expect(specs).toBeGreaterThan(256);
    const { device, writes } = fakeDevice({ maxStorageBufferBindingSize: 2 ** 27, maxBufferSize: 2 ** 28 });
    const renderer = createRenderer();
    renderer.configure(device, "bgra8unorm", 1, scene);
    renderer.upload(scene, prepared);
    const meta = writes.filter((write) => write.elements === specs * 4);
    expect(meta.length).toBeGreaterThan(0);
    expect(meta.at(-1)!.buffer.size).toBeGreaterThanOrEqual(specs * 4 * 4);
    expect(renderer.bufferFailures).toEqual([]);
  });

  it("reports a buffer past the device's limit instead of cutting it", () => {
    const scene = createScene({
      painter: () => ({ quads: shadowQuads(3000), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
    });
    const { device } = fakeDevice({ maxStorageBufferBindingSize: 200_000, maxBufferSize: 2 ** 28 });
    const renderer = createRenderer();
    renderer.configure(device, "bgra8unorm", 1, scene);
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    renderer.upload(scene, scene.prepare(VIEW, "near"));
    const quads = renderer.bufferFailures.find((failure) => failure.buffer === "quads");
    expect(quads).toMatchObject({ reason: "limit", limit: 200_000 });
    expect(quads!.bytes).toBeGreaterThan(200_000);
  });
});

describe("a fresh order buffer", () => {
  it("is written whole on its first upload, even when the scene's order did not change", () => {
    const scene = createScene({
      painter: () => ({ quads: shadowQuads(40), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    expect(scene.prepare(VIEW, "near").orderChanged).toBe(true);
    const steady = scene.prepare(VIEW, "near");
    expect(steady.orderChanged).toBe(false);
    const orderWrites = (writes: Written[]) =>
      writes.filter((write) => write.buffer.size === scene.orderBuffer.length * 4 && write.elements === scene.orderCount);
    // A new device generation makes every buffer again: the order must follow.
    for (const generation of [1, 2]) {
      const { device, writes } = fakeDevice({ maxStorageBufferBindingSize: 2 ** 27, maxBufferSize: 2 ** 28 });
      const renderer = createRenderer();
      renderer.configure(device, "bgra8unorm", generation, scene);
      renderer.upload(scene, steady);
      expect(orderWrites(writes)).toHaveLength(1);
      // And only once: the next steady frame writes nothing.
      renderer.upload(scene, scene.prepare(VIEW, "near"));
      expect(orderWrites(writes)).toHaveLength(1);
    }
  });

  it("is written whole after a regrow, whatever orderChanged says", () => {
    const scene = createScene({
      painter: () => ({ quads: shadowQuads(40), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
    });
    const { device, writes } = fakeDevice({ maxStorageBufferBindingSize: 2 ** 27, maxBufferSize: 2 ** 28 });
    const renderer = createRenderer();
    renderer.configure(device, "bgra8unorm", 1, scene);
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    const prepared = scene.prepare(VIEW, "near");
    renderer.upload(scene, { ...prepared, orderChanged: false });
    const grownOrder = writes.filter((write) => write.buffer.size === scene.orderBuffer.length * 4 && write.elements === scene.orderCount);
    expect(scene.orderCount).toBeGreaterThan(0);
    expect(grownOrder).toHaveLength(1);
  });
});

describe("the atlas cells table", () => {
  it("uploads only the dirty slot runs the atlas names, not the whole table", () => {
    const scene = createScene({ painter: () => ({ quads: [], dim: { opacity: 1, saturate: 1 }, lift: 0 }) });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    const writes: Array<{ readonly offset: number; readonly from: number; readonly elements: number }> = [];
    const { device } = fakeDevice({ maxStorageBufferBindingSize: 2 ** 27, maxBufferSize: 2 ** 28 });
    const queue = (device as unknown as { queue: { writeBuffer: (...args: unknown[]) => void } }).queue;
    const cells = new Float32Array(1000 * 8);
    let dirty = { all: false, slots: [] as number[] };
    queue.writeBuffer = (_buffer, offset, data, from = 0, elements = 0) => {
      if (data === cells) writes.push({ offset: offset as number, from: from as number, elements: elements as number });
    };
    let revision = 0;
    const renderer = createRenderer();
    renderer.configure(device, "bgra8unorm", 1, scene, {
      texture: { createView: () => ({}) } as unknown as GPUTexture,
      sampler: {} as GPUSampler,
      cells,
      cellCount: 1000,
      takeDirtyCells: () => {
        const taken = dirty;
        dirty = { all: false, slots: [] };
        return taken;
      },
    });
    const prepare = () => ({ ...scene.prepare(VIEW, "near"), atlasRevision: revision });
    renderer.upload(scene, prepare());
    writes.length = 0;
    revision = 1;
    dirty = { all: false, slots: [7, 3, 4, 900, 5] };
    renderer.upload(scene, prepare());
    // Slots 3 to 5 are one run, 7 another, 900 a third.
    expect(writes).toEqual([
      { offset: 3 * 32, from: 24, elements: 24 },
      { offset: 7 * 32, from: 56, elements: 8 },
      { offset: 900 * 32, from: 7200, elements: 8 },
    ]);
  });
});

describe("the cull's candidates", () => {
  it("keep every tier when the GPU culls, and only the current tier when the CPU does", () => {
    const tiered = (key: string, tiers: number): Quad =>
      ({ key, kind: "shape", band: "cards", z: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, tiers, scale: { kind: "board" }, style: {} }) as unknown as Quad;
    const scene = createScene({ painter: () => ({ quads: [tiered("near", 1), tiered("far", 4)], dim: { opacity: 1, saturate: 1 }, lift: 0 }) });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    expect(scene.prepare(VIEW, "near").orderChanged).toBe(true);
    expect(scene.orderCount).toBe(1);
    scene.setCullOnGpu(true);
    scene.prepare(VIEW, "near");
    expect(scene.orderCount).toBe(2);
    scene.setCullOnGpu(false);
    scene.prepare(VIEW, "near");
    expect(scene.orderCount).toBe(1);
  });
});
