import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockCanvasesHome = join(tmpdir(), `vellum-canvas-paths-${randomUUID()}`);

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
  writeCanvasSidecar,
} from "../src/main/vellum/canvases";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";

const stateLive = makeStateEngineLive(
  join(mockCanvasesHome, ".vellum", "state", "vellum.db"),
);
const repositoriesLive = Layer.provideMerge(WorkRepositoryLive, stateLive);
const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
const runtime = ManagedRuntime.make(
  canvasesLive,
);
let canvases: Context.Tag.Service<typeof CanvasesService>;

const emptyDoc = { nodes: [], edges: [] } as const;
const rejected = async (effect: Effect.Effect<unknown, unknown>): Promise<void> => {
  const outcome = await runtime.runPromise(Effect.either(effect));
  expect(outcome._tag).toBe("Left");
};

const runHeadless = async (script: "digest.ts" | "render.ts", name: string) => {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bun",
      [`scripts/${script}`, name],
      {
        cwd: globalThis.process.cwd(),
        env: {
          ...globalThis.process.env,
          VELLUM_CANVASES_DIR: join(mockCanvasesHome, ".vellum", "canvases"),
        },
      },
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

  it("validates the sidecar suffix inside the filesystem sink", async () => {
    await runtime.runPromise(canvases.create("sidecar-sink"));

    await expect(
      writeCanvasSidecar("sidecar-sink", "canvas" as never, "not-json"),
    ).rejects.toThrow("unsupported canvas sidecar suffix");

    await expect(
      access(
        join(
          mockCanvasesHome,
          ".vellum",
          "canvases",
          "sidecar-sink.canvas",
        ),
      ),
    ).rejects.toThrow();
  });

  it("keeps one checked repository root for the complete sidecar write", async () => {
    const previousRoot = process.env.VELLUM_CANVASES_DIR;
    const rootA = join(mockCanvasesHome, "root-a");
    const outside = join(mockCanvasesHome, "outside-root");
    const swapped = join(mockCanvasesHome, "swapped-root");
    await mkdir(rootA, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, swapped);
    process.env.VELLUM_CANVASES_DIR = rootA;
    try {
      await runtime.runPromise(canvases.create("stable-root"));
      const pending = writeCanvasSidecar("stable-root", "svg", "<svg/>");
      process.env.VELLUM_CANVASES_DIR = swapped;
      const written = await pending;

      expect(written).toBe(join(rootA, "stable-root.svg"));
      await expect(access(join(outside, "stable-root.svg"))).rejects.toThrow();
    } finally {
      if (previousRoot === undefined) delete process.env.VELLUM_CANVASES_DIR;
      else process.env.VELLUM_CANVASES_DIR = previousRoot;
    }
  });

  it("allows only one concurrent creator to publish a canvas", async () => {
    const results = await Promise.allSettled([
      runtime.runPromise(canvases.create("exclusive-create")),
      runtime.runPromise(canvases.create("exclusive-create")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects traversal and weird names before every document or sidecar operation", async () => {
    const outside = join(mockCanvasesHome, "outside.canvas");
    await mkdir(mockCanvasesHome, { recursive: true });
    await writeFile(outside, "outside must survive", "utf8");

    for (const name of ["../outside", "/tmp/outside", "subdir/name", "name%2fchild", ".dot"]) {
      await rejected(canvases.read(name));
      await rejected(canvases.write(name, emptyDoc));
      await rejected(canvases.mutate(name, (current) => current));
      await rejected(canvases.create(name));
      await rejected(canvases.remove(name));
      await rejected(canvases.writeSidecar(name, "digest.txt", "cannot escape"));
    }

    expect(await readFile(outside, "utf8")).toBe("outside must survive");
  });

  it("does not follow sidecar symlinks outside the repository", async () => {
    const root = join(mockCanvasesHome, ".vellum", "canvases");
    const outsideSidecar = join(mockCanvasesHome, "outside.digest.txt");
    await runtime.runPromise(canvases.create("safe"));
    await mkdir(root, { recursive: true });
    await writeFile(outsideSidecar, "outside sidecar", "utf8");
    await symlink(outsideSidecar, join(root, "safe.digest.txt"));

    await rejected(canvases.writeSidecar("safe", "digest.txt", "replacement"));

    expect(await readFile(outsideSidecar, "utf8")).toBe("outside sidecar");
    const listed = await runtime.runPromise(canvases.list);
    expect(listed.map((entry) => entry.name)).toContain("safe");
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
          ".vellum",
          "canvases",
          "portfolio-2026.canvas",
        ),
      ),
    ).rejects.toThrow();
  });

  it("makes digest and render reject traversal before either CLI reads or writes", async () => {
    const outside = join(mockCanvasesHome, "outside-cli.canvas");
    await writeFile(outside, "outside CLI sentinel", "utf8");

    for (const script of ["digest.ts", "render.ts"] as const) {
      const result = await runHeadless(script, "../outside-cli");
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("invalid canvas name");
    }

    expect(await readFile(outside, "utf8")).toBe("outside CLI sentinel");
  });
});
