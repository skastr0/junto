import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// b5-races: canvases.ts write() used a single non-unique `${path}.tmp` per
// canvas name with no mutual exclusion — two concurrent writers to the same
// canvas raced the same tmp file, and the loser's content could silently
// vanish while its Effect still resolved as success. Fixed with (1) a
// unique-per-write tmp path and (2) a per-canvas-name promise-chain mutex
// that fully serializes overlapping write() calls. This exercises the fix
// against a real (isolated, tmpdir-backed) filesystem — no fs mocking — so a
// regression in either the uniqueness or the ordering shows up as either a
// rejected writer or corrupted/wrong-final-content on disk.

const mockCanvasesHome = join(tmpdir(), `vellum-b5-races-canvases-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

// canvases.ts imports its value-level deps via the `@shared/*` bundler
// alias, which only electron-vite's build resolves — there is no
// vitest.config.ts wiring that alias for the test runner (a pre-existing
// gap, not introduced here). Re-point those two specifiers at the real
// modules via a relative path so this test exercises the genuine
// decode/mirror/serialize pipeline, not a reimplementation of it.
vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import type { CanvasDoc } from "../src/shared/canvas";
import { serializeCanvas } from "../src/shared/canvas";

const runtime = ManagedRuntime.make(CanvasesLive);
let canvases: Context.Tag.Service<typeof CanvasesService>;

beforeAll(async () => {
  canvases = await runtime.runPromise(CanvasesService);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

const docFor = (i: number): CanvasDoc => ({
  nodes: [{ id: "n1", type: "text", text: `write-${i}`, x: 0, y: 0, width: 100, height: 50 }],
  edges: [],
});

const textOf = (doc: CanvasDoc): string | undefined => {
  const node = doc.nodes[0];
  return node && node.type === "text" ? node.text : undefined;
};

describe("canvases.ts write() — same-name concurrency", () => {
  it("20 concurrent writers to one canvas: zero rejected, final content is whichever writer settled last", async () => {
    const CANVAS_NAME = "race-canvas";
    const completionOrder: number[] = [];

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        runtime.runPromise(canvases.write(CANVAS_NAME, docFor(i))).then((value) => {
          completionOrder.push(i);
          return value;
        }),
      ),
    );

    // No writer rejected — the mutex serializes instead of dropping a loser.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(completionOrder).toHaveLength(20);
    expect(new Set(completionOrder).size).toBe(20); // each writer completed exactly once

    // Because writes to one canvas name are now fully serialized, whichever
    // writer's Effect settles LAST in wall-clock order is, by construction,
    // the one that actually ran (and renamed) last — so the file on disk
    // must match its content, not some earlier writer's.
    const lastWriterIndex = completionOrder[completionOrder.length - 1];

    const read = await runtime.runPromise(canvases.read(CANVAS_NAME));
    expect(textOf(read.doc)).toBe(`write-${lastWriterIndex}`);
  });

  it("interleaved writes to two different canvas names never cross-contaminate", async () => {
    const [aResults, bResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runtime.runPromise(canvases.write("race-a", docFor(1000 + i))),
        ),
      ),
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runtime.runPromise(canvases.write("race-b", docFor(2000 + i))),
        ),
      ),
    ]);
    expect(aResults).toHaveLength(10);
    expect(bResults).toHaveLength(10);

    const readA = await runtime.runPromise(canvases.read("race-a"));
    const readB = await runtime.runPromise(canvases.read("race-b"));
    expect(textOf(readA.doc)).toMatch(/^write-10\d\d$/);
    expect(textOf(readB.doc)).toMatch(/^write-20\d\d$/);
  });

  it("rejects a stale renderer revision without overwriting the external document", async () => {
    const name = "revision-conflict";
    await runtime.runPromise(canvases.write(name, docFor(1)));
    const stale = await runtime.runPromise(canvases.read(name));
    const external = docFor(2);
    await writeFile(stale.path, serializeCanvas(external), "utf8");

    await expect(
      runtime.runPromise(canvases.write(name, docFor(3), stale.revision)),
    ).rejects.toThrow("changed on disk");

    const preserved = await runtime.runPromise(canvases.read(name));
    expect(textOf(preserved.doc)).toBe("write-2");
    expect(preserved.revision).not.toBe(stale.revision);
  });

  it("reapplies an idempotent mutation over a direct-file edit instead of overwriting it", async () => {
    const name = "mutate-external-conflict";
    await runtime.runPromise(canvases.write(name, docFor(20)));
    const initial = await runtime.runPromise(canvases.read(name));
    let injectedExternalWrite = false;

    await runtime.runPromise(
      canvases.mutate(name, (current) => {
        if (!injectedExternalWrite) {
          injectedExternalWrite = true;
          writeFileSync(initial.path, serializeCanvas(docFor(21)), "utf8");
        }
        return {
          ...current,
          nodes: current.nodes.map((node) => ({
            ...node,
            ether: { ...(node.ether ?? {}), flags: ["attention"] },
          })),
        };
      }),
    );

    const result = await runtime.runPromise(canvases.read(name));
    expect(textOf(result.doc)).toBe("write-21");
    expect(result.doc.nodes[0]?.ether?.flags).toEqual(["attention"]);
  });

  it("reports a genuine external write immediately after an own write", async () => {
    const name = "watch-near-own-write";
    const notifications: string[] = [];
    const unsubscribe = canvases.subscribeChanges((changed) => notifications.push(changed));
    canvases.start();

    try {
      await runtime.runPromise(canvases.write(name, docFor(10)));
      const current = await runtime.runPromise(canvases.read(name));
      await writeFile(current.path, serializeCanvas(docFor(11)), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(notifications.filter((changed) => changed === name)).toHaveLength(2);
      const external = await runtime.runPromise(canvases.read(name));
      expect(textOf(external.doc)).toBe("write-11");
    } finally {
      unsubscribe();
    }
  });
});
