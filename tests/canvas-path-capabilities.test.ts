import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockCanvasesHome = join(tmpdir(), `junto-canvas-paths-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});
vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import {
  CanvasesLive,
  CanvasesService,
  canvasNameFrom,
} from "../src/main/junto/canvases";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";

const stateLive = makeStateEngineLive(
  join(mockCanvasesHome, ".junto", "state", "junto.db"),
);
const repositoriesLive = Layer.provideMerge(WorkRepositoryLive, stateLive);
const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
const runtime = ManagedRuntime.make(
  canvasesLive,
);
let canvases: Context.Service.Shape<typeof CanvasesService>;

const emptyDoc = { nodes: [], edges: [] } as const;
const rejected = async (effect: Effect.Effect<unknown, unknown>): Promise<void> => {
  const outcome = await runtime.runPromise(Effect.result(effect));
  expect(outcome._tag).toBe("Failure");
};

const runHeadless = async (script: "digest.ts", name: string) => {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bun",
      [`scripts/${script}`, name],
      { cwd: globalThis.process.cwd() },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        const exitCode = typeof code === "number" ? code : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
};

beforeAll(async () => {
  canvases = await runtime.runPromise(CanvasesService);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

describe("canvas path capability boundary", () => {
  it("mints only one ASCII basename and never normalizes a path into authority", () => {
    expect(canvasNameFrom("  Portfolio-2026  ")).toBe("portfolio-2026");
    expect(canvasNameFrom("Work_Board")).toBe("work_board");
    expect(canvasNameFrom("a".repeat(64))).toBe("a".repeat(64));
    for (const raw of [
      "../outside",
      "..",
      "/tmp/outside",
      "nested/name",
      "nested\\name",
      ".hidden",
      "name%2fchild",
      "name%5cchild",
      "ｐｏｒｔｆｏｌｉｏ",
      "name\u0000suffix",
      "K",
      "a".repeat(65),
    ]) {
      expect(() => canvasNameFrom(raw)).toThrow("invalid canvas name");
    }
  });

  it("does not create a canvases directory while bootstrapping SQLite authority", async () => {
    await runtime.runPromise(canvases.list);

    await expect(
      access(join(mockCanvasesHome, ".junto", "canvases")),
    ).rejects.toThrow();
  });

  it("allows only one concurrent creator to publish a canvas", async () => {
    const results = await Promise.allSettled([
      runtime.runPromise(canvases.create("exclusive-create")),
      runtime.runPromise(canvases.create("exclusive-create")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects traversal and weird names before every document operation", async () => {
    const outside = join(mockCanvasesHome, "outside.canvas");
    await mkdir(mockCanvasesHome, { recursive: true });
    await writeFile(outside, "outside must survive", "utf8");

    for (const name of ["../outside", "/tmp/outside", "subdir/name", "name%2fchild", ".dot"]) {
      await rejected(canvases.read(name));
      await rejected(canvases.write(name, emptyDoc));
      await rejected(canvases.mutate(name, (current) => current));
      await rejected(canvases.create(name));
      await rejected(canvases.remove(name));
    }

    expect(await readFile(outside, "utf8")).toBe("outside must survive");
  });

  it("returns no locator and writes no document file", async () => {
    const created = await runtime.runPromise(canvases.create("portfolio-2026"));
    const read = await runtime.runPromise(canvases.read("portfolio-2026"));
    const listed = await runtime.runPromise(canvases.list);
    const summary = listed.find((entry) => entry.name === "portfolio-2026");
    expect(created).not.toHaveProperty("path");
    expect(read).not.toHaveProperty("path");
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty("path");
    await expect(
      access(
        join(
          mockCanvasesHome,
          ".junto",
          "canvases",
          "portfolio-2026.canvas",
        ),
      ),
    ).rejects.toThrow();
  });

  it("makes digest reject traversal before the CLI reads", async () => {
    const outside = join(mockCanvasesHome, "outside-cli.canvas");
    await writeFile(outside, "outside CLI sentinel", "utf8");

    for (const script of ["digest.ts"] as const) {
      const result = await runHeadless(script, "../outside-cli");
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("invalid canvas name");
    }

    expect(await readFile(outside, "utf8")).toBe("outside CLI sentinel");
  });
});
