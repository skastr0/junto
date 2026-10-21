/**
 * The shot of a page box comment (B7): main reads where the page is
 * scrolled, crops the live view to the box and judges the PNG it made.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeBrowserProfileService } from "../src/main/junto/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/junto/browser/sessions";
import type { ResolvedPageTarget } from "../src/main/junto/browser/page-target";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import type { Rect } from "../src/shared/page-box";
import { PAGE_SHOT_MAX_BYTES, pageShotRefusal, pngSize } from "../src/shared/page-shot";
import { localBrowserTestMachineName } from "./browser-test-machine";
import { memoryTouchedOriginStore } from "./support/touched-origin-store";

const PAGE: ResolvedPageTarget = {
  ref: "junto://canvas/work?node=n1",
  nodeId: "n1",
  url: "https://box.example.com/",
  profile: "personal",
};

/** A PNG header declaring this size: all a shot's judge reads. */
const png = (width: number, height: number, bytes = 64): Uint8Array => {
  const out = new Uint8Array(bytes);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
};

type Fake = { viewport: unknown; shot: Uint8Array; crops: Array<Rect | undefined>; drawn?: Rect };

const makeAdapter = (fake: Fake): BrowserViewAdapter => (_partition, events) => {
  let resolveDestroyed!: () => void;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const handle: BrowserViewHandle = {
    loadUrl: async (url, expectedSessionId) => {
      const sessionId = events.onNavigationStart({ url: new URL(url).href, isSameDocument: false, expectedSessionId });
      if (sessionId !== undefined) {
        events.onNavigationUrl(sessionId, new URL(url).href);
        events.onDocumentCommitted(new URL(url).href);
        events.onLoadOk(sessionId, "loaded");
      }
    },
    attach: () => {},
    setBounds: () => {},
    detach: () => {},
    destroy: () => resolveDestroyed(),
    whenDestroyed: () => destroyed,
    readViewport: async () => fake.viewport,
    drawBox: async () => fake.drawn,
    capturePagePng: async (rect) => {
      fake.crops.push(rect);
      return fake.shot;
    },
  };
  return handle;
};

describe("a page box's shot", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  let fake: Fake;
  let service: BrowserSessionService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-box-capture-"));
    runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    fake = { viewport: { width: 800, height: 600, scroll: { x: 0, y: 100 }, devicePixelRatio: 2 }, shot: png(200, 100), crops: [] };
    service = new BrowserSessionService(makeAdapter(fake), localBrowserTestMachineName, makeBrowserProfileService(sql, join(root, "browser")));
    service.setTouchedOriginStore(memoryTouchedOriginStore());
  });
  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const open = async (): Promise<string> => {
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    return opened.data.sessionId;
  };

  it("crops the live view to the box where it now sits, and keeps where the page was", async () => {
    const sessionId = await open();
    const shot = await service.captureBoxForOwner("junto-ui", sessionId, { x: 10, y: 150, w: 100, h: 50 });
    expect(shot).toMatchObject({
      ok: true,
      data: { url: "https://box.example.com/", scroll: { x: 0, y: 100 }, rect: { x: 10, y: 150, w: 100, h: 50 } },
    });
    expect(fake.crops).toEqual([{ x: 10, y: 50, w: 100, h: 50 }]);
  });

  it("refuses a box not wholly in view, and a view that will not say where it is", async () => {
    const sessionId = await open();
    expect(await service.captureBoxForOwner("junto-ui", sessionId, { x: 10, y: 20, w: 100, h: 50 })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not wholly in view/),
    });
    expect(await service.captureBoxForOwner("junto-ui", sessionId, { x: 750, y: 150, w: 100, h: 50 })).toMatchObject({ ok: false });
    fake.viewport = { width: 800 };
    expect(await service.captureBoxForOwner("junto-ui", sessionId, { x: 10, y: 150, w: 10, h: 10 })).toMatchObject({ ok: false });
    expect(fake.crops).toEqual([]);
  });

  it("judges the shot it made: a PNG, at most 2 MiB and 4096 pixels on a side", async () => {
    const sessionId = await open();
    fake.shot = png(5000, 10);
    expect(await service.captureBoxForOwner("junto-ui", sessionId, { x: 10, y: 150, w: 10, h: 10 })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/4096/),
    });
    fake.shot = new TextEncoder().encode("<svg/>");
    expect(await service.captureBoxForOwner("junto-ui", sessionId, { x: 10, y: 150, w: 10, h: 10 })).toMatchObject({ ok: false });
    expect(pageShotRefusal(png(10, 10, PAGE_SHOT_MAX_BYTES + 1))).toBe("too_large");
    expect(pageShotRefusal(png(4096, 4096))).toBeUndefined();
    expect(pngSize(png(3, 4))).toEqual({ width: 3, height: 4 });
    expect(pngSize(png(0, 4))).toBeUndefined();
  });

  it("refuses a seat's capture while the operator holds the page", async () => {
    const sessionId = await open();
    expect(await service.openForOwner("job-a", PAGE)).toMatchObject({ ok: true });
    expect(await service.captureBoxForOwner("job-a", sessionId, { x: 10, y: 150, w: 10, h: 10 })).toMatchObject({ ok: true });
    service.takeOver(sessionId);
    expect(await service.captureBoxForOwner("job-a", sessionId, { x: 10, y: 150, w: 10, h: 10 })).toMatchObject({
      ok: false,
      code: "operator_holds",
    });
    // The operator's own capture still goes.
    expect(await service.captureBoxForOwner("junto-ui", sessionId, { x: 10, y: 150, w: 10, h: 10 })).toMatchObject({ ok: true });
  });

  it("draws a box over the operator's view and shoots it where the page now sits", async () => {
    const sessionId = await open();
    fake.drawn = { x: 10, y: 50, w: 100, h: 50 };
    expect(await service.drawBox(sessionId)).toMatchObject({
      ok: true,
      data: { url: "https://box.example.com/", scroll: { x: 0, y: 100 }, rect: { x: 10, y: 150, w: 100, h: 50 } },
    });
    expect(fake.crops).toEqual([{ x: 10, y: 50, w: 100, h: 50 }]);
    fake.drawn = undefined;
    expect(await service.drawBox(sessionId)).toEqual({ ok: true, data: undefined });
    expect(fake.crops).toHaveLength(1);
  });
});
