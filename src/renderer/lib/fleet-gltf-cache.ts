/*
 * Shared GLTF templates for fleet machine signatures.
 * One network parse per URL; every viewer gets a deep clone so dispose is
 * instance-local and does not tear down the cached template or siblings.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const templates = new Map<string, Promise<THREE.Object3D>>();

const disposeObject = (root: THREE.Object3D): void => {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
};

const deepCloneObject3D = (source: THREE.Object3D): THREE.Object3D => {
  const clone = source.clone(true);
  clone.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) mesh.geometry = mesh.geometry.clone();
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => material.clone());
    } else if (mesh.material) {
      mesh.material = mesh.material.clone();
    }
  });
  return clone;
};

const prepareTemplate = (scene: THREE.Object3D): THREE.Object3D => {
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  scene.position.sub(center);
  scene.scale.setScalar(2.55 / maxDimension);
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const standard = material as THREE.MeshStandardMaterial;
      if (typeof standard.roughness !== "number") continue;
      standard.roughness = 0.48;
      standard.metalness = 0.16;
    }
  });
  return scene;
};

const fetchTemplate = (src: string): Promise<THREE.Object3D> =>
  new Promise((resolve, reject) => {
    loader.load(
      src,
      (gltf) => {
        try {
          resolve(prepareTemplate(gltf.scene));
        } catch (error) {
          disposeObject(gltf.scene);
          reject(error);
        }
      },
      undefined,
      (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

const loadTemplate = (src: string): Promise<THREE.Object3D> => {
  let pending = templates.get(src);
  if (!pending) {
    pending = fetchTemplate(src).catch((error) => {
      // Drop failed entries so a later open can retry.
      templates.delete(src);
      throw error;
    });
    templates.set(src, pending);
  }
  return pending;
};

/** Resolve a deep clone of the shared template for `src`. Safe to call concurrently. */
export const loadFleetGltfClone = (src: string): Promise<THREE.Object3D> =>
  loadTemplate(src).then((template) => deepCloneObject3D(template));

export const disposeFleetGltfClone = (root: THREE.Object3D): void => {
  disposeObject(root);
};

/** Warm the template cache without attaching a viewer (hover / idle prefetch). */
export const prefetchFleetGltf = (src: string): void => {
  void loadTemplate(src).catch(() => undefined);
};
