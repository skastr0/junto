import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockCanvasesHome = join(tmpdir(), `vellum-canvas-remove-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";

const runtime = ManagedRuntime.make(CanvasesLive);
let canvases: Context.Tag.Service<typeof CanvasesService>;

beforeAll(async () => {
  canvases = await runtime.runPromise(CanvasesService);
});

afterAll(async () => {
  await runtime.dispose();
  const { rm } = await import("node:fs/promises");
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe("canvases.ts remove()", () => {
  it("deletes the canvas document and known sidecars", async () => {
    const name = "to-delete";
    await runtime.runPromise(canvases.create(name));
    const listBefore = await runtime.runPromise(canvases.list);
    expect(listBefore.some((row) => row.name === name)).toBe(true);

    const dir = join(mockCanvasesHome, ".vellum", "canvases");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.digest.txt`), "digest body", "utf8");
    await writeFile(join(dir, `${name}.svg`), "<svg/>", "utf8");
    await writeFile(join(dir, `${name}.canvas.pre-recovery.bak`), "bak", "utf8");

    const result = await runtime.runPromise(canvases.remove(name));
    expect(result.name).toBe(name);

    const listAfter = await runtime.runPromise(canvases.list);
    expect(listAfter.some((row) => row.name === name)).toBe(false);
    expect(await pathExists(join(dir, `${name}.canvas`))).toBe(false);
    expect(await pathExists(join(dir, `${name}.digest.txt`))).toBe(false);
    expect(await pathExists(join(dir, `${name}.svg`))).toBe(false);
    // Unknown sidecars / recovery backups are left alone.
    expect(await pathExists(join(dir, `${name}.canvas.pre-recovery.bak`))).toBe(true);
  });

  it("fails when the canvas does not exist", async () => {
    const error = await runtime.runPromise(Effect.either(canvases.remove("missing-canvas")));
    expect(error._tag).toBe("Left");
    if (error._tag === "Left") {
      expect(error.left.message).toMatch(/does not exist/);
    }
  });

  it("rejects invalid names", async () => {
    const error = await runtime.runPromise(Effect.either(canvases.remove("Bad Name!")));
    expect(error._tag).toBe("Left");
    if (error._tag === "Left") {
      expect(error.left.message).toMatch(/invalid canvas name/);
    }
  });

  it("notifies change subscribers with the deleted name", async () => {
    const name = "notify-me";
    await runtime.runPromise(canvases.create(name));

    const seen: string[] = [];
    const unsubscribe = canvases.subscribeChanges((changed) => seen.push(changed));
    await runtime.runPromise(canvases.remove(name));
    unsubscribe();

    expect(seen).toContain(name);
  });

  it("notifies subscribeChanges listeners after write (own-write path)", async () => {
    // Kernel rehydrate depends on this: own-write suppress would silence fs.watch,
    // so write() must notify listeners itself for live phase honesty.
    const name = "write-notify";
    await runtime.runPromise(canvases.create(name));

    const seen: string[] = [];
    const unsubscribe = canvases.subscribeChanges((changed) => seen.push(changed));
    await runtime.runPromise(
      canvases.write(name, {
        nodes: [{ id: "n1", type: "text", text: "after-write", x: 0, y: 0, width: 100, height: 50 }],
        edges: [],
      }),
    );
    unsubscribe();

    expect(seen).toContain(name);
  });

  it("notifies subscribeChanges listeners after mutate", async () => {
    const name = "mutate-notify";
    await runtime.runPromise(canvases.create(name));

    const seen: string[] = [];
    const unsubscribe = canvases.subscribeChanges((changed) => seen.push(changed));
    await runtime.runPromise(
      canvases.mutate(name, (doc) => ({
        ...doc,
        nodes: [
          ...doc.nodes,
          { id: "extra", type: "text" as const, text: "mutated", x: 10, y: 10, width: 80, height: 40 },
        ],
      })),
    );
    unsubscribe();

    expect(seen).toContain(name);
  });

  it("serializes remove behind write mutex (no clobber of a concurrent write after delete)", async () => {
    const name = "mutex-delete";
    await runtime.runPromise(canvases.create(name));

    // Start a write, then remove — both use the same mutex key. After both
    // settle, the canvas must either exist with the written content or be
    // fully gone; never a partial/corrupt intermediate.
    const writeDoc = {
      nodes: [{ id: "n1", type: "text" as const, text: "late-write", x: 0, y: 0, width: 100, height: 50 }],
      edges: [],
    };

    const results = await Promise.allSettled([
      runtime.runPromise(canvases.write(name, writeDoc)),
      runtime.runPromise(canvases.remove(name)),
    ]);

    // At least one path completed; remove may race after write or before.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const list = await runtime.runPromise(canvases.list);
    const stillThere = list.find((row) => row.name === name);
    if (stillThere) {
      // Write won last — document is valid JSON canvas.
      const read = await runtime.runPromise(canvases.read(name));
      expect(read.doc.nodes.length).toBeGreaterThan(0);
    } else {
      const dir = join(mockCanvasesHome, ".vellum", "canvases");
      expect(await pathExists(join(dir, `${name}.canvas`))).toBe(false);
    }
  });

  it("list no longer returns a removed canvas", async () => {
    const a = "keep-a";
    const b = "drop-b";
    await runtime.runPromise(canvases.create(a));
    await runtime.runPromise(canvases.create(b));
    await runtime.runPromise(canvases.remove(b));
    const names = (await runtime.runPromise(canvases.list)).map((row) => row.name);
    expect(names).toContain(a);
    expect(names).not.toContain(b);
  });
});
