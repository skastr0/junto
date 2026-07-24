import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATION_PROJECTION_FRAME_MAGIC,
  STATION_PROJECTION_SCHEMA,
  STATION_PROJECTION_SCOPE,
  compareProjectionGeneration,
  StationProjectionManifestV1,
} from "../src/shared/station-projection";
import {
  compileStationProjection,
  parseStationProjectionFrame,
  StationProjectionCompileError,
} from "../src/main/vellum/projection/compiler";
import {
  applyStationProjectionGeneration,
  loadStationProjectionSnapshot,
  StationProjectionStoreError,
} from "../src/main/vellum/projection/station-store";
import { Schema, Either } from "effect";

const WITNESS_A = "a".repeat(64);
const WITNESS_B = "b".repeat(64);
const WITNESS_C = "c".repeat(64);

const body = (text: string): Uint8Array => new TextEncoder().encode(text);

const compile = (
  generation: string,
  documents: ReadonlyMap<string, Uint8Array>,
  opts?: { readonly cc?: string; readonly target?: string },
) =>
  compileStationProjection({
    generation,
    createdAt: "2026-07-24T00:00:00.000Z",
    commandCenterWitness: opts?.cc ?? WITNESS_A,
    targetWitness: opts?.target ?? WITNESS_B,
    documents,
  });

describe("station projection schema", () => {
  it("decodes a well-formed full-canvas-set manifest", () => {
    const raw = {
      schema: STATION_PROJECTION_SCHEMA,
      scope: STATION_PROJECTION_SCOPE,
      generation: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      intentSha256: WITNESS_C,
      documents: [
        {
          name: "portfolio",
          bytes: 2,
          sha256: "d".repeat(64),
        },
      ],
    };
    const result = Schema.decodeUnknownEither(StationProjectionManifestV1)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects non-full-canvas-set scope and bad witnesses", () => {
    const badScope = Schema.decodeUnknownEither(StationProjectionManifestV1)({
      schema: STATION_PROJECTION_SCHEMA,
      scope: "partial",
      generation: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      intentSha256: WITNESS_C,
      documents: [],
    });
    expect(Either.isLeft(badScope)).toBe(true);

    const badWitness = Schema.decodeUnknownEither(StationProjectionManifestV1)({
      schema: STATION_PROJECTION_SCHEMA,
      scope: STATION_PROJECTION_SCOPE,
      generation: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: "not-a-hash",
      targetWitness: WITNESS_B,
      intentSha256: WITNESS_C,
      documents: [],
    });
    expect(Either.isLeft(badWitness)).toBe(true);
  });

  it("compares generations with BigInt order", () => {
    expect(compareProjectionGeneration("9", "10")).toBe(-1);
    expect(compareProjectionGeneration("10", "10")).toBe(0);
    expect(compareProjectionGeneration("100", "99")).toBe(1);
  });
});

describe("station projection compiler", () => {
  it("round-trips compile → parse with sorted documents", () => {
    const docs = new Map([
      ["zeta", body('{"nodes":[],"edges":[]}\n')],
      ["alpha", body('{"nodes":[{"id":"n1"}],"edges":[]}\n')],
    ]);
    const compiled = compile("7", docs);
    expect(compiled.manifest.schema).toBe(STATION_PROJECTION_SCHEMA);
    expect(compiled.manifest.scope).toBe(STATION_PROJECTION_SCOPE);
    expect(compiled.manifest.generation).toBe("7");
    expect(compiled.manifest.documents.map((d) => d.name)).toEqual([
      "alpha",
      "zeta",
    ]);

    const magic = new TextEncoder().encode(STATION_PROJECTION_FRAME_MAGIC);
    expect(
      new TextDecoder().decode(compiled.frame.subarray(0, magic.byteLength)),
    ).toBe(STATION_PROJECTION_FRAME_MAGIC);

    const parsed = parseStationProjectionFrame(compiled.frame);
    expect(parsed.manifest.generation).toBe("7");
    expect(parsed.frameSha256).toBe(compiled.frameSha256);
    expect(parsed.manifestSha256).toBe(compiled.manifestSha256);
    expect(parsed.documents.get("alpha")).toEqual(docs.get("alpha"));
    expect(parsed.documents.get("zeta")).toEqual(docs.get("zeta"));
  });

  it("fails closed on corrupt frame bytes", () => {
    const compiled = compile(
      "1",
      new Map([["solo", body("{}\n")]]),
    );
    const corrupted = new Uint8Array(compiled.frame);
    corrupted[corrupted.byteLength - 1] ^= 0xff;
    expect(() => parseStationProjectionFrame(corrupted)).toThrow(
      StationProjectionCompileError,
    );

    const truncated = compiled.frame.subarray(0, 8);
    expect(() => parseStationProjectionFrame(truncated)).toThrow(
      StationProjectionCompileError,
    );

    const badMagic = new Uint8Array(compiled.frame);
    badMagic[0] = 0x00;
    expect(() => parseStationProjectionFrame(badMagic)).toThrow(
      StationProjectionCompileError,
    );
  });

  it("rejects non-canonical canvas names at compile time", () => {
    expect(() =>
      compile(
        "1",
        new Map([["Bad Name", body("x")]]),
      ),
    ).toThrow(StationProjectionCompileError);
  });
});

describe("station projection store", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("admits a higher generation and reloads the snapshot", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    const gen1 = compile(
      "1",
      new Map([["alpha", body('{"nodes":[],"edges":[]}\n')]]),
    );
    const first = await applyStationProjectionGeneration(
      { kind: "compiled", compiled: gen1 },
      root,
    );
    expect(first.status).toBe("installed");
    expect(first.generation).toBe("1");

    const gen2 = compile(
      "2",
      new Map([
        ["alpha", body('{"nodes":[],"edges":[]}\n')],
        ["beta", body('{"nodes":[{"id":"n"}],"edges":[]}\n')],
      ]),
    );
    const second = await applyStationProjectionGeneration(
      { kind: "frame", frame: gen2.frame },
      root,
    );
    expect(second.status).toBe("installed");
    expect(second.generation).toBe("2");

    const loaded = await loadStationProjectionSnapshot(root);
    expect(loaded?.pointer.generation).toBe("2");
    expect(loaded?.pointer.frameSha256).toBe(gen2.frameSha256);
    expect(loaded?.documents.get("beta")).toEqual(
      gen2.documents.find((d) => d.name === "beta")?.body,
    );
  });

  it("is idempotent for the same generation + frame hash", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    const compiled = compile(
      "3",
      new Map([["solo", body("hello\n")]]),
    );
    const a = await applyStationProjectionGeneration(
      { kind: "compiled", compiled },
      root,
    );
    const b = await applyStationProjectionGeneration(
      { kind: "frame", frame: compiled.frame },
      root,
    );
    expect(a.status).toBe("installed");
    expect(b.status).toBe("idempotent");
    expect(b.frameSha256).toBe(a.frameSha256);
  });

  it("refuses a stale (lower) generation", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    await applyStationProjectionGeneration(
      {
        kind: "compiled",
        compiled: compile("10", new Map([["a", body("1")]])),
      },
      root,
    );
    await expect(
      applyStationProjectionGeneration(
        {
          kind: "compiled",
          compiled: compile("9", new Map([["a", body("1")]])),
        },
        root,
      ),
    ).rejects.toMatchObject({
      name: "StationProjectionStoreError",
      code: "stale",
    });
  });

  it("conflicts when same generation carries a different frame", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    await applyStationProjectionGeneration(
      {
        kind: "compiled",
        compiled: compile("5", new Map([["a", body("one")]])),
      },
      root,
    );
    await expect(
      applyStationProjectionGeneration(
        {
          kind: "compiled",
          compiled: compile("5", new Map([["a", body("two")]])),
        },
        root,
      ),
    ).rejects.toMatchObject({
      name: "StationProjectionStoreError",
      code: "conflict",
    });
  });

  it("fails closed on corrupt current pointer", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    await applyStationProjectionGeneration(
      {
        kind: "compiled",
        compiled: compile("1", new Map([["a", body("x")]])),
      },
      root,
    );
    await writeFile(join(root, "current.json"), "{not-json", "utf8");
    await expect(loadStationProjectionSnapshot(root)).rejects.toBeInstanceOf(
      StationProjectionStoreError,
    );
  });

  it("returns undefined when no pointer exists", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    await expect(loadStationProjectionSnapshot(root)).resolves.toBeUndefined();
  });

  it("refuses corrupt frames at apply", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-station-proj-"));
    const compiled = compile("1", new Map([["a", body("x")]]));
    const bad = new Uint8Array(compiled.frame);
    bad[bad.byteLength - 1] ^= 0xff;
    await expect(
      applyStationProjectionGeneration({ kind: "frame", frame: bad }, root),
    ).rejects.toMatchObject({ code: "corrupt" });
  });
});
