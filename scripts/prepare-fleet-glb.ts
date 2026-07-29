#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

interface GlbChunk {
  readonly type: number;
  readonly data: Buffer;
}

const pad4 = (length: number): number => (4 - (length % 4)) % 4;

const parseGlb = (source: Buffer): { json: Record<string, any>; binary: Buffer } => {
  if (source.readUInt32LE(0) !== GLB_MAGIC || source.readUInt32LE(4) !== 2) {
    throw new Error("Expected a binary glTF 2.0 file");
  }

  const chunks: GlbChunk[] = [];
  let offset = 12;
  while (offset < source.length) {
    const length = source.readUInt32LE(offset);
    const type = source.readUInt32LE(offset + 4);
    chunks.push({ type, data: source.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }

  const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
  const binaryChunk = chunks.find((chunk) => chunk.type === BIN_CHUNK);
  if (!jsonChunk || !binaryChunk) throw new Error("GLB must contain JSON and BIN chunks");

  return {
    json: JSON.parse(jsonChunk.data.toString("utf8").trim()),
    binary: binaryChunk.data,
  };
};

const usedBufferViews = (json: Record<string, any>): Set<number> => {
  const used = new Set<number>();
  for (const accessor of json.accessors ?? []) {
    if (typeof accessor.bufferView === "number") used.add(accessor.bufferView);
    if (typeof accessor.sparse?.indices?.bufferView === "number") {
      used.add(accessor.sparse.indices.bufferView);
    }
    if (typeof accessor.sparse?.values?.bufferView === "number") {
      used.add(accessor.sparse.values.bufferView);
    }
  }
  return used;
};

const prepare = (json: Record<string, any>, binary: Buffer): Buffer => {
  const retained = [...usedBufferViews(json)].sort((left, right) => left - right);
  const remap = new Map(retained.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const binaryParts: Buffer[] = [];
  let byteOffset = 0;

  json.bufferViews = retained.map((oldIndex) => {
    const view = json.bufferViews?.[oldIndex];
    if (!view) throw new Error(`Missing referenced bufferView ${oldIndex}`);
    const start = view.byteOffset ?? 0;
    const bytes = binary.subarray(start, start + view.byteLength);
    const alignment = pad4(byteOffset);
    if (alignment) {
      binaryParts.push(Buffer.alloc(alignment));
      byteOffset += alignment;
    }
    const next = { ...view, buffer: 0, byteOffset };
    binaryParts.push(bytes);
    byteOffset += bytes.length;
    return next;
  });

  for (const accessor of json.accessors ?? []) {
    if (typeof accessor.bufferView === "number") {
      accessor.bufferView = remap.get(accessor.bufferView);
    }
    if (typeof accessor.sparse?.indices?.bufferView === "number") {
      accessor.sparse.indices.bufferView = remap.get(accessor.sparse.indices.bufferView);
    }
    if (typeof accessor.sparse?.values?.bufferView === "number") {
      accessor.sparse.values.bufferView = remap.get(accessor.sparse.values.bufferView);
    }
  }

  json.images = undefined;
  json.textures = undefined;
  json.samplers = undefined;
  json.extensionsUsed = (json.extensionsUsed ?? []).filter(
    (extension: string) => extension !== "EXT_texture_webp",
  );
  json.extensionsRequired = (json.extensionsRequired ?? []).filter(
    (extension: string) => extension !== "EXT_texture_webp",
  );
  if (json.extensionsUsed.length === 0) json.extensionsUsed = undefined;
  if (json.extensionsRequired.length === 0) json.extensionsRequired = undefined;

  json.materials = [
    {
      name: "Vellum dither clay",
      pbrMetallicRoughness: {
        baseColorFactor: [0.86, 0.76, 0.61, 1],
        metallicFactor: 0.12,
        roughnessFactor: 0.52,
      },
    },
  ];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) primitive.material = 0;
  }

  const compactBinary = Buffer.concat(binaryParts);
  json.buffers = [{ byteLength: compactBinary.length }];

  const encodedJson = Buffer.from(JSON.stringify(json));
  const jsonPadding = pad4(encodedJson.length);
  const binaryPadding = pad4(compactBinary.length);
  const paddedJson = Buffer.concat([encodedJson, Buffer.alloc(jsonPadding, 0x20)]);
  const paddedBinary = Buffer.concat([compactBinary, Buffer.alloc(binaryPadding)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const result = Buffer.alloc(totalLength);

  result.writeUInt32LE(GLB_MAGIC, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(totalLength, 8);
  result.writeUInt32LE(paddedJson.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  paddedJson.copy(result, 20);
  const binaryHeader = 20 + paddedJson.length;
  result.writeUInt32LE(paddedBinary.length, binaryHeader);
  result.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
  paddedBinary.copy(result, binaryHeader + 8);
  return result;
};

const SIMPLIFY_RATIO = 0.25;

const makeSpec = (inputPath: string, outputName: string) => ({
  version: "v2",
  meta: { name: `Prepare ${outputName}`, tags: ["fleet", "decimate"] },
  inputs: [{ id: "source", source: "file", path_or_url: inputPath }],
  steps: [
    {
      id: "pack",
      uses: "gltf.pack.v1",
      with: {
        input_mesh: { from_input: "source" },
        profile_ref: "profile.universal-runtime.glb.v1",
        asset_category: "prop",
        simplify_ratio: SIMPLIFY_RATIO,
        meshopt: false,
        output_name: `${outputName}-packed`,
      },
    },
  ],
  outputs: { mesh: { from_step: "pack", output: "mesh" } },
});

const runFlare = async (specPath: string): Promise<string> => {
  const proc = Bun.spawn(["flare", "run", specPath, "--wait"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(proc.stdout).json();
  const exitCode = await proc.exited;
  if (exitCode !== 0 || output.ok !== true) {
    throw new Error(`flare run failed: ${JSON.stringify(output)}`);
  }
  const meshArtifact = output.data.artifacts.find(
    (a: any) => a.metadata?.channel_name === "mesh",
  );
  if (!meshArtifact?.store_uri) {
    throw new Error("flare run did not emit a mesh artifact");
  }
  return meshArtifact.store_uri as string;
};

const decimateWithFlare = async (inputPath: string, tmpDir: string): Promise<string> => {
  const name = basename(inputPath, ".glb");
  const specPath = resolve(tmpDir, `${name}.spec.json`);
  await writeFile(specPath, JSON.stringify(makeSpec(resolve(inputPath), name)));
  return runFlare(specPath);
};

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: bun scripts/prepare-fleet-glb.ts <input.glb> <output.glb>");
  process.exit(1);
}

const tmpDir = await mkdtemp(join(tmpdir(), "fleet-prepare-"));
let decimatedUri: string | undefined;
try {
  decimatedUri = await decimateWithFlare(inputPath, tmpDir);
} finally {
  if (decimatedUri === undefined) {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const source = Buffer.from(await Bun.file(decimatedUri).arrayBuffer());
const { json, binary } = parseGlb(source);
const prepared = prepare(json, binary);
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, prepared);

// Clean up the temp flare spec and any temporary flare artifacts we can reach.
await rm(tmpDir, { recursive: true, force: true });

console.log(`${inputPath} -> ${outputPath} (${source.length} -> ${prepared.length} bytes, gltfpack + material strip)`);
