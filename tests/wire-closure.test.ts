/**
 * The phone-facing wire modules (src/shared/wire/) have an import closure of
 * `effect` alone, so the mobile repo can copy them without the rest of the
 * app (docs/companion-protocol.md, "Shared wire modules"). Any import that
 * leaves the directory, any other package, and any Node or DOM global fails
 * here, and so fails the build.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WIRE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "shared", "wire");
const ALLOWED_PACKAGES = new Set(["effect"]);
const FORBIDDEN_GLOBALS = /\b(?:Buffer|process|window|document|require|globalThis|navigator|__dirname)\b/u;

const specifiersOf = (source: string): ReadonlyArray<string> => {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'";]*?\bfrom\s*["']([^"']+)["']/gu,
    /\bexport\s+(?:type\s+)?[^'";]*?\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]!);
  return found;
};

/** Code only: comments may mention anything. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");

const wireFiles = readdirSync(WIRE).filter((name) => name.endsWith(".ts"));

describe("wire module import closure", () => {
  it("holds the modules the contract names", () => {
    expect(new Set(wireFiles)).toEqual(
      new Set(["agent-signals.ts", "companion-protocol.ts", "operator-feed.ts", "thread-health.ts"]),
    );
  });

  for (const file of wireFiles) {
    it(`${file} reaches only effect and sibling wire modules`, () => {
      const path = join(WIRE, file);
      const source = readFileSync(path, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(path), specifier);
          expect(dirname(target), `${file} imports ${specifier}`).toBe(WIRE);
          expect(wireFiles, `${file} imports ${specifier}`).toContain(`${target.slice(WIRE.length + 1)}.ts`);
        } else {
          expect(ALLOWED_PACKAGES.has(specifier.split("/")[0]!), `${file} imports ${specifier}`).toBe(true);
        }
      }
      const code = stripComments(source);
      expect(FORBIDDEN_GLOBALS.exec(code)?.[0], `${file} uses a platform global`).toBeUndefined();
    });
  }

  it("the checker itself catches an escape", () => {
    expect(specifiersOf('import { x } from "../canvas";\nexport * from "node:fs";\nimport type { Y } from "@shared/z";')).toEqual([
      "../canvas",
      "@shared/z",
      "node:fs",
    ]);
  });
});
