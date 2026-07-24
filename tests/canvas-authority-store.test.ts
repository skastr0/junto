import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import {
  CanvasAuthorityError,
  commitAuthorityGeneration,
  loadAuthoritySnapshot,
} from "../src/main/vellum/canvas-authority/store";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { compareAuthorityGeneration } from "../src/shared/canvas-authority";
import { applyMirrorLaw, type CanvasDoc } from "../src/shared/canvas";

describe("canvas authority store", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("commits documents and reloads an identical snapshot", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-authority-"));
    const bodyA = new TextEncoder().encode('{"nodes":[],"edges":[]}\n');
    const bodyB = new TextEncoder().encode(
      '{"nodes":[{"id":"n1","type":"text","x":0,"y":0,"width":10,"height":10,"text":"hi"}],"edges":[]}\n',
    );
    const snap = await commitAuthorityGeneration(
      {
        generation: "1",
        createdAt: "2026-07-24T00:00:00.000Z",
        documents: new Map([
          ["alpha", bodyA],
          ["beta", bodyB],
        ]),
      },
      root,
    );
    expect(snap.pointer.generation).toBe("1");
    expect(snap.manifest.documents).toHaveLength(2);

    const loaded = await loadAuthoritySnapshot(root);
    expect(loaded?.pointer).toEqual(snap.pointer);
    expect(loaded?.manifest.intentSha256).toBe(snap.manifest.intentSha256);
    expect(loaded?.documents.get("alpha")).toEqual(bodyA);
    expect(loaded?.documents.get("beta")).toEqual(bodyB);
  });

  it("fails closed on corrupt current pointer", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-authority-"));
    await commitAuthorityGeneration(
      {
        generation: "2",
        createdAt: "2026-07-24T00:00:00.000Z",
        documents: new Map([["solo", new TextEncoder().encode("{}\n")]]),
      },
      root,
    );
    await writeFile(join(root, "current.json"), "{not-json", "utf8");
    await expect(loadAuthoritySnapshot(root)).rejects.toBeInstanceOf(
      CanvasAuthorityError,
    );
  });

  it("returns undefined when no pointer exists", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-authority-"));
    await expect(loadAuthoritySnapshot(root)).resolves.toBeUndefined();
  });

  it("compares generations with BigInt order", () => {
    expect(compareAuthorityGeneration("9", "10")).toBe(-1);
    expect(compareAuthorityGeneration("10", "10")).toBe(0);
    expect(compareAuthorityGeneration("100", "99")).toBe(1);
  });
});

const noteDoc = (text: string): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: "n1",
        type: "text",
        text,
        x: 0,
        y: 0,
        width: 120,
        height: 60,
      },
    ],
    edges: [],
  });

describe("CanvasesService authority store", () => {
  let canvasesDir = "";
  let authorityDir = "";
  let previousCanvases: string | undefined;
  let previousAuthority: string | undefined;
  let runtime: ManagedRuntime.ManagedRuntime<
    CanvasesService,
    never
  > | undefined;

  const installEnv = async (): Promise<void> => {
    canvasesDir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    authorityDir = await mkdtemp(join(tmpdir(), "vellum-auth-live-"));
    previousCanvases = process.env.VELLUM_CANVASES_DIR;
    previousAuthority = process.env.VELLUM_CANVAS_AUTHORITY_DIR;
    process.env.VELLUM_CANVASES_DIR = canvasesDir;
    process.env.VELLUM_CANVAS_AUTHORITY_DIR = authorityDir;
  };

  const restoreEnv = async (): Promise<void> => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (previousCanvases === undefined) delete process.env.VELLUM_CANVASES_DIR;
    else process.env.VELLUM_CANVASES_DIR = previousCanvases;
    if (previousAuthority === undefined) {
      delete process.env.VELLUM_CANVAS_AUTHORITY_DIR;
    } else {
      process.env.VELLUM_CANVAS_AUTHORITY_DIR = previousAuthority;
    }
    if (canvasesDir) await rm(canvasesDir, { recursive: true, force: true });
    if (authorityDir) await rm(authorityDir, { recursive: true, force: true });
    canvasesDir = "";
    authorityDir = "";
  };

  afterEach(async () => {
    await restoreEnv();
  });

  it("commits sequential authority generations on write and create", async () => {
    await installEnv();
    runtime = ManagedRuntime.make(CanvasesLive);
    const canvases = await runtime.runPromise(CanvasesService);

    await runtime.runPromise(canvases.write("alpha", noteDoc("one")));

    const liveGen = await runtime.runPromise(canvases.liveAuthorityGeneration());
    expect(liveGen).toBe("1");

    const gen1 = await loadAuthoritySnapshot(authorityDir);
    expect(gen1?.pointer.generation).toBe("1");
    expect(gen1?.manifest.documents.map((d) => d.name)).toEqual(["alpha"]);
    expect(new TextDecoder().decode(gen1!.documents.get("alpha")!)).toContain(
      "one",
    );

    await runtime.runPromise(canvases.write("alpha", noteDoc("two")));
    await runtime.runPromise(canvases.create("beta"));

    const gen3 = await loadAuthoritySnapshot(authorityDir);
    expect(gen3?.pointer.generation).toBe("3");
    expect(
      gen3?.manifest.documents.map((d) => d.name).slice().sort(),
    ).toEqual(["alpha", "beta"]);
    expect(new TextDecoder().decode(gen3!.documents.get("alpha")!)).toContain(
      "two",
    );

    const readBeta = await runtime.runPromise(canvases.read("beta"));
    expect(readBeta.doc.nodes).toEqual([]);
  });

  it("reloads the live map from the authority store across restart", async () => {
    await installEnv();
    runtime = ManagedRuntime.make(CanvasesLive);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("alpha", noteDoc("authority-wins")));
    await runtime.dispose();
    runtime = undefined;

    runtime = ManagedRuntime.make(CanvasesLive);
    const reloaded = await runtime.runPromise(CanvasesService);
    const list = await runtime.runPromise(reloaded.list);
    expect(list.map((row) => row.name)).toEqual(["alpha"]);

    const read = await runtime.runPromise(reloaded.read("alpha"));
    const text =
      read.doc.nodes[0] && read.doc.nodes[0].type === "text"
        ? read.doc.nodes[0].text
        : undefined;
    expect(text).toBe("authority-wins");
  });

  it("starts empty when the authority pointer is absent", async () => {
    await installEnv();
    runtime = ManagedRuntime.make(CanvasesLive);
    const canvases = await runtime.runPromise(CanvasesService);
    const list = await runtime.runPromise(canvases.list);
    expect(list).toEqual([]);

    await runtime.runPromise(canvases.write("first", noteDoc("minted")));
    const snap = await loadAuthoritySnapshot(authorityDir);
    expect(snap?.pointer.generation).toBe("1");
    expect(snap?.manifest.documents.map((d) => d.name)).toEqual(["first"]);
  });

  it("remove drops the document from the next authority generation", async () => {
    await installEnv();
    runtime = ManagedRuntime.make(CanvasesLive);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.create("keep"));
    await runtime.runPromise(canvases.create("drop"));
    await runtime.runPromise(canvases.remove("drop"));

    const snap = await loadAuthoritySnapshot(authorityDir);
    expect(snap?.pointer.generation).toBe("3");
    expect(snap?.manifest.documents.map((d) => d.name)).toEqual(["keep"]);
    await expect(
      runtime.runPromise(Effect.either(canvases.read("drop"))),
    ).resolves.toMatchObject({ _tag: "Left" });
  });

  it("corrupt pointer blocks authoring without collapsing the store", async () => {
    await installEnv();
    runtime = ManagedRuntime.make(CanvasesLive);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("alpha", noteDoc("kept")));
    await runtime.dispose();
    runtime = undefined;

    await writeFile(join(authorityDir, "current.json"), "{not-json", "utf8");

    runtime = ManagedRuntime.make(CanvasesLive);
    const blocked = await runtime.runPromise(CanvasesService);
    await expect(
      runtime.runPromise(Effect.either(blocked.write("beta", noteDoc("nope")))),
    ).resolves.toMatchObject({ _tag: "Left" });
    const doctor = await runtime.runPromise(blocked.doctor);
    expect(doctor.status).toBe("error");
    expect(doctor.detail).toMatch(/corrupt/i);
  });

  it("orphan store objects without a pointer block authoring", async () => {
    await installEnv();
    runtime = ManagedRuntime.make(CanvasesLive);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("alpha", noteDoc("object")));
    await runtime.dispose();
    runtime = undefined;

    await rm(join(authorityDir, "current.json"), { force: true });

    runtime = ManagedRuntime.make(CanvasesLive);
    const blocked = await runtime.runPromise(CanvasesService);
    await expect(
      runtime.runPromise(Effect.either(blocked.write("beta", noteDoc("nope")))),
    ).resolves.toMatchObject({ _tag: "Left" });
    const doctor = await runtime.runPromise(blocked.doctor);
    expect(doctor.status).toBe("error");
    expect(doctor.detail).toMatch(/recovery required/i);
  });
});
