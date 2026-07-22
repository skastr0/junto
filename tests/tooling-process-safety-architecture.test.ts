import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [join(root, "scripts"), join(root, "e2e")];

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const extension = extname(path);
    return [".ts", ".tsx", ".js", ".mjs"].includes(extension) ||
      path.endsWith("/e2e/fakes/bin/herdr")
      ? [path]
      : [];
  });

type ProcessKillSite = {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly call: ts.CallExpression;
};

const processKillSites = scanRoots.flatMap(sourceFiles).flatMap((path) => {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: ProcessKillSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.getText(source) === "process.kill" ||
        node.expression.getText(source) === "globalThis.process.kill")
    ) {
      sites.push({ file: relative(root, path), source, call: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
});

const isExistenceProbe = (site: ProcessKillSite): boolean => {
  const signal = site.call.arguments[1];
  return signal !== undefined && ts.isNumericLiteral(signal) && signal.text === "0";
};

describe("tooling process-safety architecture", () => {
  it("has no positive terminating process.kill in scripts or e2e", () => {
    const violations = processKillSites
      .filter((site) => !isExistenceProbe(site))
      .map((site) => `${site.file}:${site.call.getStart(site.source)}`)
      .sort();

    expect(violations).toEqual([]);
  });

  it("launches packaged smoke only through detached-group authority", () => {
    const source = readFileSync(join(root, "scripts", "packaged-runtime-smoke.ts"), "utf8");
    expect(source).toContain("spawnDetachedProcessGroup");
    expect(source).toContain("signalOwned");
    expect(source).toContain("releaseOwned");
    expect(source).not.toMatch(/\bspawn\s*\(/u);
    expect(source).not.toMatch(/\.kill\s*\(/u);
  });

  it("shuts down sandbox herdr through its fake-only RPC without pid discovery", () => {
    const harness = readFileSync(join(root, "e2e", "harness", "launch.ts"), "utf8");
    expect(harness).toContain('method: "server.shutdown"');
    expect(harness).not.toMatch(/\blsof\b/u);
    expect(harness).not.toMatch(/process\.kill\s*\(/u);
  });
});
