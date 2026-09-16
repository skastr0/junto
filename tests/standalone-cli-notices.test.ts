import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectStandaloneCliNotices } from "../scripts/standalone-cli-notices";

const roots: string[] = [];
const write = (file: string, contents: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
};
const fixture = (): string => {
  const root = mkdtempSync(
    path.join(tmpdir(), "junto-cli-notices-test-"),
  );
  roots.push(root);
  write(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0" }),
  );
  write(path.join(root, "src/main.ts"), "export {};\n");
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface PackageOptions {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly license?: { readonly file: string; readonly text: string } | null;
  readonly notice?: string;
}
const installPackage = (
  parent: string,
  name: string,
  version: string,
  options: PackageOptions = {},
): string => {
  const root = path.join(parent, "node_modules", name);
  write(
    path.join(root, "package.json"),
    JSON.stringify({
      name,
      version,
      main: "dist/index.js",
      // Consumers can resolve the entry but may not import package.json.
      exports: { ".": "./dist/index.js" },
      ...(options.dependencies === undefined
        ? {}
        : { dependencies: options.dependencies }),
      ...(options.optionalDependencies === undefined
        ? {}
        : { optionalDependencies: options.optionalDependencies }),
      ...(options.devDependencies === undefined
        ? {}
        : { devDependencies: options.devDependencies }),
    }),
  );
  write(
    path.join(root, "dist/index.js"),
    'throw new Error("fixture package code must not execute while collecting notices");\n',
  );
  write(
    path.join(root, "dist/package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  if (options.license !== null) {
    const license = options.license ??
      {
        file: "LICENSE",
        text:
          `Complete license for ${name}@${version}\nAll fixture terms retained.\n`,
      };
    write(path.join(root, license.file), license.text);
  }
  if (options.notice !== undefined) {
    write(path.join(root, "NOTICE"), options.notice);
  }
  return root;
};

describe("standalone CLI dependency notices", () => {
  it("closes a prebundled input over exact installed dependencies, preserving nested versions and full notices", () => {
    const root = fixture();
    const firstLicense =
      "First dependency version license\nCopyright Fixture One\nComplete redistribution terms.\n";
    const secondLicense =
      "Second dependency version license\nCopyright Fixture Two\nDifferent complete redistribution terms.\n";
    const leafLicense = "Leaf license\nEvery term on this line must survive.\n";
    const leafNotice = "Leaf NOTICE\nKeep this attribution with the license.\n";
    const tar = installPackage(root, "tar", "7.5.15", {
      dependencies: {
        "@fixture/leaf": "^1.0.0",
        "@fixture/repeated": "^1.0.0",
      },
      devDependencies: { "@fixture/dev-only": "1.0.0" },
    });
    const leaf = installPackage(root, "@fixture/leaf", "1.0.0", {
      dependencies: { "@fixture/repeated": "^2.0.0" },
      license: { file: "LICENSE.md", text: leafLicense },
      notice: leafNotice,
    });
    installPackage(root, "@fixture/repeated", "1.0.0", {
      license: { file: "license", text: firstLicense },
    });
    installPackage(leaf, "@fixture/repeated", "2.0.0", {
      license: { file: "LICENSE.txt", text: secondLicense },
    });
    installPackage(root, "@fixture/dev-only", "1.0.0", { license: null });

    const input = path.join(tar, "dist/index.js");
    const result = collectStandaloneCliNotices(root, [
      path.relative(root, input),
    ]);
    expect(result.dependencies).toEqual([
      "@fixture/leaf",
      "@fixture/repeated",
      "tar",
    ]);
    expect(result.notices).toHaveLength(4);
    const repeated = result.notices.filter((notice) =>
      notice.includes("@fixture/repeated@")
    );
    expect(repeated).toHaveLength(2);
    expect(
      repeated.find((notice) => notice.includes("@fixture/repeated@1.0.0")),
    ).toContain(firstLicense);
    expect(
      repeated.find((notice) => notice.includes("@fixture/repeated@2.0.0")),
    ).toContain(secondLicense);
    const leafBlock = result.notices.find((notice) =>
      notice.includes("@fixture/leaf@1.0.0")
    );
    expect(leafBlock).toContain(leafLicense);
    expect(leafBlock).toContain(leafNotice);
    expect(result.notices.join("\n")).not.toContain("@fixture/dev-only");
    expect(
      collectStandaloneCliNotices(root, [
        input,
        input,
        path.join(root, "src/main.ts"),
      ]),
    ).toEqual(result);
  });

  it("includes installed optional dependencies and permits absent optional dependencies", () => {
    const root = fixture();
    const tar = installPackage(root, "tar", "7.5.15", {
      dependencies: { "@fixture/absent-optional": "1.0.0" },
      optionalDependencies: {
        "@fixture/absent-optional": "1.0.0",
        "@fixture/present-optional": "1.0.0",
      },
    });
    installPackage(root, "@fixture/present-optional", "1.0.0");
    const result = collectStandaloneCliNotices(root, [
      path.join(tar, "dist/index.js"),
    ]);
    expect(result.dependencies).toEqual([
      "@fixture/present-optional",
      "tar",
    ]);
    expect(result.notices).toHaveLength(2);
  });

  it("collects only visible package notices outside the known bundle while preserving visible nested versions", () => {
    const root = fixture();
    const owner = installPackage(root, "@fixture/visible", "1.0.0", {
      dependencies: { "@fixture/unused-required": "1.0.0" },
      optionalDependencies: { "@fixture/unused-native": "1.0.0" },
      devDependencies: { "@fixture/unused-dev": "1.0.0" },
    });
    for (
      const name of [
        "@fixture/unused-required",
        "@fixture/unused-native",
        "@fixture/unused-dev",
      ]
    ) {
      installPackage(root, name, "1.0.0", { license: null });
    }
    const first = installPackage(root, "@fixture/repeated", "1.0.0");
    const second = installPackage(owner, "@fixture/repeated", "2.0.0");
    const result = collectStandaloneCliNotices(
      root,
      [owner, first, second].map((directory) =>
        path.join(directory, "dist/index.js")
      ),
    );
    expect(result.dependencies).toEqual([
      "@fixture/repeated",
      "@fixture/visible",
    ]);
    expect(result.notices).toHaveLength(3);
    expect(
      result.notices.filter((notice) => notice.includes("@fixture/repeated@")),
    ).toHaveLength(2);
    expect(result.notices.join("\n")).toContain("@fixture/repeated@1.0.0");
    expect(result.notices.join("\n")).toContain("@fixture/repeated@2.0.0");
    expect(result.notices.join("\n")).not.toContain("@fixture/unused-");
  });

  it("fails when a transitive production dependency is missing", () => {
    const root = fixture();
    const tar = installPackage(root, "tar", "7.5.15", {
      dependencies: { "@fixture/leaf": "1.0.0" },
    });
    installPackage(root, "@fixture/leaf", "1.0.0", {
      dependencies: { "@fixture/missing-required": "1.0.0" },
    });
    expect(() =>
      collectStandaloneCliNotices(root, [path.join(tar, "dist/index.js")])
    ).toThrow(/missing-required/);
  });

  it.each(["dependencies", "optionalDependencies"] as const)(
    "fails when an installed %s entry has no full license text",
    (field) => {
      const root = fixture();
      const tar = installPackage(root, "tar", "7.5.15", {
        [field]: { "@fixture/no-license": "1.0.0" },
      });
      installPackage(root, "@fixture/no-license", "1.0.0", { license: null });
      expect(() =>
        collectStandaloneCliNotices(root, [path.join(tar, "dist/index.js")])
      ).toThrow(/license/i);
    },
  );
});
