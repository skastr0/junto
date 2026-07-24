import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FLEET_MACHINE_MODELS } from "../src/renderer/lib/fleet-machine-model";

const assetPath = (id: string): string =>
  resolve(import.meta.dirname, `../src/renderer/assets/fleet/${id}.glb`);

const glbJson = (path: string): Record<string, unknown> => {
  const file = readFileSync(path);
  expect(file.readUInt32LE(0)).toBe(0x46546c67);
  expect(file.readUInt32LE(4)).toBe(2);
  const jsonLength = file.readUInt32LE(12);
  expect(file.readUInt32LE(16)).toBe(0x4e4f534a);
  return JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8").trim());
};

describe("fleet machine assets", () => {
  it.each(FLEET_MACHINE_MODELS)("%s is a CSP-safe compact GLB", (id) => {
    const json = glbJson(assetPath(id));
    expect(json.images).toBeUndefined();
    expect(json.textures).toBeUndefined();
    expect(json.samplers).toBeUndefined();
    expect(json.extensionsUsed ?? []).not.toContain("EXT_texture_webp");
    expect(json.extensionsRequired ?? []).not.toContain("EXT_texture_webp");
    expect(json.meshes).toBeDefined();
  });
});
