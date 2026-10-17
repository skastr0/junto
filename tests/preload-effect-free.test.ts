/**
 * The sandboxed preload may not carry Effect. Effect's top-level scheduler
 * setup collides with the sandbox wrapper's parameters, the preload throws,
 * and `window.junto` never appears (3bd21bb30, fixed in 2e950ff2e). So no
 * module the preload reaches at runtime may import `effect` or a module that
 * does. Type-only imports are erased by the bundler and are not followed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const ENTRY = join(root, "src", "preload", "index.ts");

const isEffect = (specifier: string): boolean =>
  specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@effect/");

const resolveLocal = (from: string, specifier: string): string | undefined => {
  const base = specifier.startsWith("@shared/")
    ? join(root, "src", "shared", specifier.slice("@shared/".length))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : undefined;
  if (base === undefined) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  return undefined;
};

/** Runtime imports and re-exports of one source: what the bundle keeps. */
export const runtimeSpecifiers = (source: string): string[] => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers: string[] = [];
  const statement = /\b(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(statement)) {
    const [, , typeOnly, clause, specifier] = match;
    if (typeOnly) continue;
    // `import { type A, type B } from` keeps nothing at runtime.
    const named = clause!.match(/^\{([\s\S]*)\}$/);
    if (named && named[1]!.split(",").map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith("type "))) {
      continue;
    }
    specifiers.push(specifier!);
  }
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  // A dynamic import is a value; `import("x").Name` in a type position is not.
  for (const match of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)(\s*\.\s*(\w+))?/g)) {
    if (match[2] === undefined || match[3] === "then") specifiers.push(match[1]!);
  }
  return specifiers;
};

/** Each Effect import the preload reaches, as the chain of files that leads to it. */
const effectChains = (): string[] => {
  const seen = new Set<string>();
  const found: string[] = [];
  const walk = (file: string, chain: readonly string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, relative(root, file)];
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (isEffect(specifier)) {
        found.push(`${here.join(" -> ")} -> ${specifier}`);
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next !== undefined) walk(next, here);
    }
  };
  walk(ENTRY, []);
  return found;
};

describe("sandboxed preload", () => {
  it("reaches no Effect import at runtime", () => {
    expect(effectChains()).toEqual([]);
  });

  it("follows runtime imports and re-exports, and skips type-only ones", () => {
    const specifiers = runtimeSpecifiers(`
      import type { A } from "effect";
      import { type B, type C } from "@shared/typed";
      export type { D } from "./d";
      import { Schema } from "effect";
      import { thing, type E } from "./mixed";
      export { managedHarnessEnabled } from "./managed-terminal-templates";
      export * from "./everything";
      import "./side-effect";
      // import { commented } from "./commented";
      type Pad = import("./pad").Pad;
      const loaded = await import("./loaded");
      void import("./then").then(() => undefined);
    `);
    expect(specifiers.sort()).toEqual(
      ["effect", "./mixed", "./managed-terminal-templates", "./everything", "./side-effect", "./loaded", "./then"].sort(),
    );
  });
});
