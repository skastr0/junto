/**
 * canvas-nodes, review of 97c9e4156 (page reclaim) and 3187352ae (burst
 * dedupe). What the services tests do not ask.
 *
 * Reclaim: a page past the bind budget gives back a texture the side map
 * still names; a page reclaimed with a mip pass pending; page 0 reclaimed and
 * reused keeps the reserved texel; the idle clock restarts when a holder
 * comes and goes; a holder that shows a cell through a stand-in keeps its page.
 * Burst: the winner released while waiters show it; waiters whose winner's
 * page is refused late; a device attached again while waiters wait; no slot
 * is left behind after a burst is released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice } from "./gpu-atlas-strict-device";
import { settle } from "./gpu-canvas-fakes";

const style: QuadStyle = { ink: { token: "ink" } };
const quad = (key: string, size = 40): Quad => ({
  key: "q", kind: "sprite", band: "cards", z: 0, rect: { x: 0, y: 0, width: size, height: size }, tiers: 0, scale: { kind: "board" }, style,
  sprite: { atlas: "image", key, size: { width: size, height: size } } as SpriteRef,
});
const px = (size: number, stamp = 9): AtlasPixels =>
  ({ width: size, height: size, data: new Uint8Array(size * size * 4).fill(stamp), stampAt: () => stamp, close: () => undefined }) as unknown as AtlasPixels;
const FAKE = { toFake: ["setTimeout", "clearTimeout", "performance"] } as const;
const real = async (): Promise<void> => {
  vi.useRealTimers();
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
  vi.useFakeTimers(FAKE);
};
const pass = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  await settle();
};
const refuseNext = (device: GPUDevice): void => {
  const pop = device.popErrorScope.bind(device);
  let left = 1;
  device.popErrorScope = () => {
    const real = pop();
    if (left <= 0) return real;
    left -= 1;
    void real;
    return Promise.resolve({ message: "out of memory" });
  };
};
const make = (limits?: Partial<GPUSupportedLimits>, extra: Record<string, unknown> = {}) => {
  const strict = strictDevice(limits === undefined ? {} : { limits });
  const atlas = createGpuAtlas({ size: 64, rasterizeSpriteSync: (q) => px(Math.ceil(q.rect.width)), ...extra });
  atlas.attach(strict.device);
  return { atlas, strict };
};
/** No texture a frame can bind is a destroyed one. */
const bound = (atlas: ReturnType<typeof make>["atlas"]): GPUTexture[] => [
  atlas.binding.texture,
  ...(atlas.binding.coverageTexture ? [atlas.binding.coverageTexture] : []),
  ...(atlas.binding.rgbaPages ?? []),
  ...(atlas.binding.coveragePages ?? []),
  ...(atlas.binding.standalone ? [...atlas.binding.standalone.values()] : []),
];
const destroyedAmongBound = (atlas: ReturnType<typeof make>["atlas"], strict: ReturnType<typeof make>["strict"]): number => {
  const dead = new Set(strict.textures.filter((t) => t.isDestroyed()).map((t) => t.id));
  return bound(atlas).filter((t) => dead.has((t as unknown as { id: number }).id)).length;
};

beforeEach(() => vi.useFakeTimers(FAKE));
afterEach(() => vi.useRealTimers());

describe("page reclaim", () => {
  it("a page past the bind budget leaves no destroyed texture to bind", async () => {
    const { atlas, strict } = make({ maxSampledTexturesPerShaderStage: 2 });
    const cells = [0, 1, 2, 3].map((i) => atlas.acquire(quad(`k${i}`), 1));
    await real();
    expect(atlas.stats().pages).toBe(4);
    expect(destroyedAmongBound(atlas, strict)).toBe(0);
    for (const c of cells) atlas.release(c);
    await pass(10_000);
    expect(atlas.stats().pages).toBe(0);
    expect(destroyedAmongBound(atlas, strict)).toBe(0);
    expect(atlas.audit().samples).toEqual([]);
    expect(strict.errors).toEqual([]);
  });

  it("reclaiming one of three pages leaves the other two drawn and both audits clean", async () => {
    const { atlas, strict } = make();
    const a = atlas.acquire(quad("a"), 1);
    const b = atlas.acquire(quad("b"), 1);
    const c = atlas.acquire(quad("c"), 1);
    await real();
    expect(atlas.stats().pages).toBe(3);
    atlas.release(b);
    await pass(10_000);
    expect(atlas.stats().pages).toBe(2);
    expect(atlas.hasImage(a)).toBe(true);
    expect(atlas.hasImage(c)).toBe(true);
    expect(destroyedAmongBound(atlas, strict)).toBe(0);
    vi.useRealTimers();
    const audit = await atlas.auditTexels(10);
    expect(audit.mismatches).toEqual([]);
    expect(audit.checked).toBe(2);
    expect(atlas.audit().samples).toEqual([]);
    expect(strict.errors).toEqual([]);
  });

  it("page 0 reclaimed then reused keeps the reserved texel clear and the key lands again", async () => {
    const { atlas, strict } = make();
    const a = atlas.acquire(quad("a"), 1);
    await real();
    atlas.release(a);
    await pass(10_000);
    expect(atlas.stats().pages).toBe(0);
    vi.useRealTimers();
    const again = atlas.acquire(quad("a"), 1);
    await real();
    expect(atlas.hasImage(again)).toBe(true);
    const audit = await atlas.auditTexels(10);
    expect(audit.mismatches).toEqual([]);
    expect(audit.checked).toBe(1);
    expect(atlas.audit().samples).toEqual([]);
    expect(destroyedAmongBound(atlas, strict)).toBe(0);
    expect(strict.errors).toEqual([]);
  });

  it("a mip pass pending when the page goes is dropped, not begun on a destroyed texture", async () => {
    const { atlas, strict } = make();
    const a = atlas.acquire(quad("a"), 1);
    await real();
    // Land a second cell on the same page's plot after the first flush, then release both at once.
    const b = atlas.acquire(quad("b", 8), 1);
    atlas.ensureNow?.(b);
    atlas.release(a);
    atlas.release(b);
    await pass(10_000);
    await settle();
    expect(strict.errors).toEqual([]);
  });

  it("a holder returning at 9 s restarts the span: reclaimed 10 s after its second release", async () => {
    const { atlas } = make();
    const a = atlas.acquire(quad("a"), 1);
    await real();
    atlas.release(a);
    await pass(9_000);
    const back = atlas.acquire(quad("a"), 1); // a cache hit: landed, no drain, so the fake clock and its timers stay
    await pass(500);
    atlas.release(back);
    await pass(9_999);
    expect(atlas.stats().pages).toBe(1);
    await pass(1);
    expect(atlas.stats().pages).toBe(0);
  });

  it("a cell shown through a stand-in holds its page", async () => {
    const { atlas } = make(undefined, {});
    const small = atlas.acquire(quad("same", 40), 1);
    await real();
    // A bigger ask for the same content shows the small cell until its own pixels land.
    const held = atlas.acquire(quad("same", 41), 1, small);
    atlas.release(small);
    await pass(10_000);
    await real();
    expect(atlas.hasImage(held)).toBe(true);
    expect(atlas.audit().samples).toEqual([]);
  });
});

describe("burst dedupe", () => {
  const burst = (n: number) => {
    const decodes: Array<(p: AtlasPixels) => void> = [];
    const marks: AtlasPixels = px(16, 3);
    const strict = strictDevice();
    const atlas = createGpuAtlas({
      size: 64,
      rasterizeSpriteSync: (q) => (q.sprite?.atlas === "mark" ? marks : undefined),
      rasterizeSprite: () => new Promise<AtlasPixels>((resolve) => decodes.push(resolve)),
    });
    atlas.attach(strict.device);
    return { atlas, strict, decodes, n };
  };
  const mark = (col: number): Quad => ({ ...quad("x", 16), sprite: { atlas: "mark", cell: { col, row: 0 } } as SpriteRef });
  const portrait = (): Quad => quad("portrait", 16);

  it("the winner's quad released while waiters show it: they keep the picture; all released, nothing left", async () => {
    const { atlas, strict, decodes } = burst(3);
    const lasts = [1, 2, 3].map((c) => atlas.acquire(mark(c), 1));
    await real();
    const asks = lasts.map((l) => atlas.acquire(portrait(), 1, l));
    await real();
    expect(decodes).toHaveLength(3);
    decodes[0]!(px(16));
    await real();
    atlas.release(asks[0]!);
    await real();
    expect(atlas.hasImage(asks[1]!)).toBe(true);
    expect(atlas.hasImage(asks[2]!)).toBe(true);
    decodes[1]!(px(16));
    decodes[2]!(px(16));
    await real();
    expect(atlas.audit().samples).toEqual([]);
    for (const a of asks.slice(1)) atlas.release(a);
    for (const l of lasts) atlas.release(l);
    await real();
    const audit = atlas.audit();
    expect(audit.samples).toEqual([]);
    expect(audit.heldCells).toBe(0);
    expect(strict.errors).toEqual([]);
  });

  it("a winner whose page is refused late: every waiter lands again after its back-off", async () => {
    const { atlas, strict, decodes } = burst(3);
    const lasts = [1, 2, 3].map((c) => atlas.acquire(mark(c), 1));
    await real();
    refuseNext(strict.device); // the portrait's page
    const asks = lasts.map((l) => atlas.acquire(portrait(), 1, l));
    await real();
    decodes[0]!(px(16));
    await real();
    for (const d of decodes.slice(1)) d(px(16));
    await real();
    // The page answered out of memory: nobody has the picture yet. Each waiter, in time, does.
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(1_000);
      await real();
      for (const d of decodes.splice(0)) d(px(16));
      await real();
    }
    for (const a of asks) expect(atlas.hasImage(a)).toBe(true);
    expect(atlas.audit().samples).toEqual([]);
    expect(strict.errors).toEqual([]);
  });

  it("a device attached again while waiters wait: every asker lands again", async () => {
    const { atlas, decodes } = burst(3);
    const lasts = [1, 2, 3].map((c) => atlas.acquire(mark(c), 1));
    await real();
    const asks = lasts.map((l) => atlas.acquire(portrait(), 1, l));
    await real();
    decodes[0]!(px(16));
    await real();
    const next = strictDevice();
    atlas.attach(next.device);
    await real();
    for (let i = 0; i < 6; i += 1) {
      for (const d of decodes.splice(0)) d(px(16));
      await real();
    }
    for (const a of asks) expect(atlas.hasImage(a)).toBe(true);
    expect(atlas.audit().samples).toEqual([]);
    expect(next.errors).toEqual([]);
  });
});
