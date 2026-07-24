import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanvasAuthorityError,
  commitAuthorityGeneration,
  loadAuthoritySnapshot,
} from "../src/main/vellum/canvas-authority/store";
import { compareAuthorityGeneration } from "../src/shared/canvas-authority";

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
