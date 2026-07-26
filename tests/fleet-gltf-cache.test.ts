import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

// GLTFLoader uses XHR/fetch; stub load to parse local fixtures.
vi.mock("three/addons/loaders/GLTFLoader.js", async () => {
  const actual = await vi.importActual<typeof import("three/addons/loaders/GLTFLoader.js")>(
    "three/addons/loaders/GLTFLoader.js",
  );
  const { GLTFLoader } = actual;
  class TestLoader extends GLTFLoader {
    override load(
      url: string,
      onLoad: (data: GLTF) => void,
      _onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void,
    ): void {
      try {
        const path = url.startsWith("/")
          ? url
          : resolve(import.meta.dirname, url);
        const file = readFileSync(path);
        this.parse(
          file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
          "",
          onLoad,
          onError,
        );
      } catch (error) {
        onError?.(error);
      }
    }
  }
  return { GLTFLoader: TestLoader };
});

describe("fleet-gltf-cache", () => {
  it("clones a shared template so dispose is instance-local", async () => {
    const { loadFleetGltfClone, disposeFleetGltfClone } = await import(
      "../src/renderer/lib/fleet-gltf-cache"
    );
    const fixture = resolve(
      import.meta.dirname,
      "../src/renderer/assets/fleet/command-core.glb",
    );
    const a = await loadFleetGltfClone(fixture);
    const b = await loadFleetGltfClone(fixture);
    expect(a).not.toBe(b);
    expect(a.children.length).toBeGreaterThan(0);
    expect(b.children.length).toBeGreaterThan(0);
    disposeFleetGltfClone(a);
    // Sibling clone still has geometry after the other instance is disposed.
    let meshes = 0;
    b.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) meshes += 1;
    });
    expect(meshes).toBeGreaterThan(0);
    disposeFleetGltfClone(b);
  });
});
