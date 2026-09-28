/**
 * Launch permission surface: what may make macOS name Junto before a click.
 *
 * macOS bills a child's file access to the GUI app at the top of its process
 * tree, so an agent Junto starts can raise a prompt that names Junto. That is
 * fine when the operator asked for the agent. What must never happen is Junto
 * causing a prompt for no reason: shell terminals start only from an explicit
 * open.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(path, "utf8");

const sourceFiles = (root: string): string[] =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });

describe("launch permission surface", () => {
  it("creates shell terminals only from the explicit open path", () => {
    const creators = sourceFiles("src/renderer").filter((path) =>
      source(path).includes("terminalCreate("),
    );
    expect(creators).toEqual([join("src/renderer/lib/terminal-actions.ts")]);
  });
});
