import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
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
const MIT_LICENSE = `MIT License

Copyright (c) 2026 Example

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

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
        path.join(modules, "@scope", "no-license"),
        "@scope/no-license",
        "1.0.0",
      ),
      writePackage(
        path.join(modules, "effect", "node_modules", "nested"),
        "nested",
        "2.0.0",
        "Apache-2.0",
      ),
    ]);
    await writeFile(
      path.join(modules, "@scope", "unknown", "LICENSE"),
      MIT_LICENSE,
    );

    const inventory = await collectDependencyLicenseInventory({
      projectDirectory: root,
      nodeModulesDirectory: modules,
      sourceRevision: "a".repeat(40),
    });
    expect(inventory.packages).toEqual([
      {
        name: "@scope/no-license",
        version: "1.0.0",
        direct: false,
        development: false,
        license: "UNKNOWN",
        licenseSource: "unresolved",
        purl: "pkg:npm/%40scope/no-license@1.0.0",
      },
      {
        name: "@scope/unknown",
        version: "1.2.3",
        direct: false,
        development: false,
        license: "MIT",
        licenseSource: "bundled-license-file",
        licenseEvidence: {
          file: "LICENSE",
          sha256: createHash("sha256").update(MIT_LICENSE).digest("hex"),
        },
        purl: "pkg:npm/%40scope/unknown@1.2.3",
      },
      {
        name: "effect",
        version: "3.0.0",
        direct: true,
        development: false,
        license: "MIT",
        licenseSource: "package-metadata",
        purl: "pkg:npm/effect@3.0.0",
      },
      {
        name: "nested",
        version: "2.0.0",
        direct: false,
        development: false,
        license: "Apache-2.0",
        licenseSource: "package-metadata",
        purl: "pkg:npm/nested@2.0.0",
      },
      {
        name: "vitest",
        version: "4.0.0",
        direct: true,
        development: true,
        license: "MIT",
        licenseSource: "package-metadata",
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
      components: expect.arrayContaining([
        expect.objectContaining({
          name: "@scope/unknown",
          licenses: [{ expression: "MIT" }],
          properties: expect.arrayContaining([
            {
              name: "vellum-command:license-source",
              value: "bundled-license-file",
            },
            {
              name: "vellum-command:license-evidence-file",
              value: "LICENSE",
            },
            {
              name: "vellum-command:license-evidence-sha256",
              value: createHash("sha256").update(MIT_LICENSE).digest("hex"),
            },
          ]),
        }),
      ]),
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

  it("does not infer rights from modified MIT text or padded sentinels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-release-sbom-"));
    roots.push(root);
    const modules = path.join(root, "node_modules");
    await mkdir(modules);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "vellum", version: "0.1.0" }),
    );
    await Promise.all([
      writePackage(
        path.join(modules, "restricted"),
        "restricted",
        "1.0.0",
      ),
      writePackage(
        path.join(modules, "unlicensed"),
        "unlicensed",
        "1.0.0",
        "UNLICENSED ",
      ),
      writePackage(
        path.join(modules, "invented"),
        "invented",
        "1.0.0",
        "Definitely-Not-A-License",
      ),
    ]);
    await writeFile(
      path.join(modules, "restricted", "LICENSE"),
      `${MIT_LICENSE}\nCommercial use is expressly prohibited.\n`,
    );
    const inventory = await collectDependencyLicenseInventory({
      projectDirectory: root,
      nodeModulesDirectory: modules,
      sourceRevision: "a".repeat(40),
    });
    expect(inventory.unknownLicenseCount).toBe(3);
    expect(inventory.packages).toEqual([
      expect.objectContaining({
        name: "invented",
        license: "UNKNOWN",
        licenseSource: "unresolved",
      }),
      expect.objectContaining({
        name: "restricted",
        license: "UNKNOWN",
        licenseSource: "unresolved",
        licenseEvidence: {
          file: "LICENSE",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      }),
      expect.objectContaining({
        name: "unlicensed",
        license: "UNKNOWN",
        licenseSource: "unresolved",
      }),
    ]);
  });

  it("rejects symlink-hidden and missing declared dependencies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-release-sbom-"));
    roots.push(root);
    const modules = path.join(root, "node_modules");
    const hidden = path.join(root, "hidden");
    await mkdir(modules);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "vellum",
        version: "0.1.0",
        dependencies: { hidden: "1.0.0" },
      }),
    );
    await writePackage(hidden, "hidden", "1.0.0", "UNLICENSED");
    await symlink("../hidden", path.join(modules, "hidden"), "dir");
    await expect(
      collectDependencyLicenseInventory({
        projectDirectory: root,
        nodeModulesDirectory: modules,
        sourceRevision: "a".repeat(40),
      }),
    ).rejects.toThrow(/non-directory entry/u);

    await rm(path.join(modules, "hidden"));
    await writePackage(path.join(modules, "good"), "good", "1.0.0", "MIT");
    await expect(
      collectDependencyLicenseInventory({
        projectDirectory: root,
        nodeModulesDirectory: modules,
        sourceRevision: "a".repeat(40),
      }),
    ).rejects.toThrow(/missing declared package/u);
  });
});
