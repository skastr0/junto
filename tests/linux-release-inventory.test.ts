import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDependencyLicenseInventory,
  createCycloneDxSbom,
} from "../scripts/linux-release-inventory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const writePackage = async (
  directory: string,
  name: string,
  version: string,
  license?: unknown,
) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version, ...(license === undefined ? {} : { license }) }),
  );
};

describe("Linux release dependency and SBOM evidence", () => {
  it("records deterministic package identities and licenses without local paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-release-sbom-"));
    roots.push(root);
    const modules = path.join(root, "node_modules");
    await mkdir(modules);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@skastr0/vellum",
        version: "0.1.0",
        dependencies: { effect: "3.0.0" },
        devDependencies: { vitest: "4.0.0" },
      }),
    );
    await Promise.all([
      writePackage(path.join(modules, "effect"), "effect", "3.0.0", "MIT"),
      writePackage(
        path.join(modules, "vitest"),
        "vitest",
        "4.0.0",
        "MIT",
      ),
      writePackage(
        path.join(modules, "@scope", "unknown"),
        "@scope/unknown",
        "1.2.3",
      ),
      writePackage(
        path.join(modules, "effect", "node_modules", "nested"),
        "nested",
        "2.0.0",
        "Apache-2.0",
      ),
    ]);

    const inventory = await collectDependencyLicenseInventory({
      projectDirectory: root,
      nodeModulesDirectory: modules,
      sourceRevision: "a".repeat(40),
    });
    expect(inventory.packages).toEqual([
      {
        name: "@scope/unknown",
        version: "1.2.3",
        direct: false,
        development: false,
        license: "UNKNOWN",
        purl: "pkg:npm/%40scope/unknown@1.2.3",
      },
      {
        name: "effect",
        version: "3.0.0",
        direct: true,
        development: false,
        license: "MIT",
        purl: "pkg:npm/effect@3.0.0",
      },
      {
        name: "nested",
        version: "2.0.0",
        direct: false,
        development: false,
        license: "Apache-2.0",
        purl: "pkg:npm/nested@2.0.0",
      },
      {
        name: "vitest",
        version: "4.0.0",
        direct: true,
        development: true,
        license: "MIT",
        purl: "pkg:npm/vitest@4.0.0",
      },
    ]);
    expect(inventory.unknownLicenseCount).toBe(1);
    expect(JSON.stringify(inventory)).not.toContain(root);

    const sbom = createCycloneDxSbom({
      inventory,
      productName: "@skastr0/vellum",
      productVersion: "0.1.0",
      sourceDateEpoch: 1_784_772_800,
    });
    expect(sbom).toMatchObject({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: "@skastr0/vellum",
          version: "0.1.0",
        },
      },
    });
    expect(JSON.stringify(sbom)).not.toContain(root);
  });

  it("refuses malformed source and package identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-release-sbom-"));
    roots.push(root);
    const modules = path.join(root, "node_modules");
    await mkdir(modules);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "vellum", version: "0.1.0" }),
    );
    await writePackage(path.join(modules, "bad"), "../bad", "1.0.0", "MIT");
    await expect(
      collectDependencyLicenseInventory({
        projectDirectory: root,
        nodeModulesDirectory: modules,
        sourceRevision: "not-a-revision",
      }),
    ).rejects.toThrow();
    await expect(
      collectDependencyLicenseInventory({
        projectDirectory: root,
        nodeModulesDirectory: modules,
        sourceRevision: "a".repeat(40),
      }),
    ).rejects.toThrow(/package name/u);
  });
});
