import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { mockCanvasesHome } = vi.hoisted(() => {
  const tempRoot = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const home = `${tempRoot}/vellum-canvas-remove-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  process.env.JUNTO_HOME = home;
  return { mockCanvasesHome: home };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";

const stateLive = makeStateEngineLive(
  join(mockCanvasesHome, ".junto", "state", "junto.db"),
);
const repositoriesLive = Layer.provideMerge(WorkRepositoryLive, stateLive);
const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
const runtime = ManagedRuntime.make(
  canvasesLive,
);
let canvases: Context.Service.Shape<typeof CanvasesService>;

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
  it("removes the canvas from authority and known agent sidecars", async () => {
    const name = "to-delete";
    await runtime.runPromise(canvases.create(name));
    const listBefore = await runtime.runPromise(canvases.list);
    expect(listBefore.some((row) => row.name === name)).toBe(true);

    const dir = join(mockCanvasesHome, ".junto", "canvases");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.digest.txt`), "digest body", "utf8");
    await writeFile(join(dir, `${name}.svg`), "<svg/>", "utf8");

    const result = await runtime.runPromise(canvases.remove(name));
    expect(result.name).toBe(name);

    const listAfter = await runtime.runPromise(canvases.list);
    expect(listAfter.some((row) => row.name === name)).toBe(false);
    await expect(
      runtime.runPromise(Effect.result(canvases.read(name))),
    ).resolves.toMatchObject({ _tag: "Failure" });
    expect(await pathExists(join(dir, `${name}.digest.txt`))).toBe(false);
    expect(await pathExists(join(dir, `${name}.svg`))).toBe(false);
  });

  it("fails when the canvas does not exist", async () => {
    const error = await runtime.runPromise(Effect.result(canvases.remove("missing-canvas")));
    expect(error._tag).toBe("Failure");
    if (error._tag === "Failure") {
      expect(error.failure.message).toMatch(/does not exist/);
    }
  });

  it("rejects invalid names", async () => {
    const error = await runtime.runPromise(Effect.result(canvases.remove("Bad Name!")));
    expect(error._tag).toBe("Failure");
    if (error._tag === "Failure") {
      expect(error.failure.message).toMatch(/invalid canvas name/);
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

  it("does not report a committed write as failed when a listener throws", async () => {
    const name = "listener-write";
    await runtime.runPromise(canvases.create(name));
    const unsubscribe = canvases.subscribeChanges(() => {
      throw new Error("listener failed");
    });

    await expect(
      runtime.runPromise(
        canvases.write(name, {
          nodes: [{ id: "n1", type: "text", text: "committed", x: 0, y: 0, width: 100, height: 50 }],
          edges: [],
        }),
      ),
    ).resolves.toBeDefined();
    unsubscribe();
    const written = await runtime.runPromise(canvases.read(name));
    expect(written.doc.nodes).toHaveLength(1);
  });

  it("does not report a committed removal as failed when a listener throws", async () => {
    const name = "listener-remove";
    await runtime.runPromise(canvases.create(name));
    const unsubscribe = canvases.subscribeChanges(() => {
      throw new Error("listener failed");
    });

    await expect(runtime.runPromise(canvases.remove(name))).resolves.toEqual({ name });
    unsubscribe();
    const list = await runtime.runPromise(canvases.list);
    expect(list.some((row) => row.name === name)).toBe(false);
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
      await expect(
        runtime.runPromise(Effect.result(canvases.read(name))),
      ).resolves.toMatchObject({ _tag: "Failure" });
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
