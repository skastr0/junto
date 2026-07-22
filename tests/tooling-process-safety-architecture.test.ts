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
    return [".ts", ".tsx", ".js", ".mjs", ".sh", ".py"].includes(extension) ||
      path.endsWith("/e2e/fakes/bin/herdr") || path.endsWith("/e2e/fakes/bin/ssh")
      ? [path]
      : [];
  });

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node;

const accessedName = (node: ts.Node): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) && node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) return node.argumentExpression.text;
  return undefined;
};

const processAliases = (source: ts.SourceFile): ReadonlySet<string> => {
  const aliases = new Set(["process"]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = unwrap(node.initializer);
        const globalProcess =
          (ts.isIdentifier(value) && aliases.has(value.text)) ||
          (ts.isPropertyAccessExpression(value) &&
            value.expression.getText(source) === "globalThis" && value.name.text === "process");
        if (globalProcess && !aliases.has(node.name.text)) {
          aliases.add(node.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
};

const isProcessExpression = (
  node: ts.Expression,
  source: ts.SourceFile,
  aliases: ReadonlySet<string>,
): boolean => {
  const value = unwrap(node);
  return (ts.isIdentifier(value) && aliases.has(value.text)) ||
    (ts.isPropertyAccessExpression(value) &&
      value.expression.getText(source) === "globalThis" && value.name.text === "process");
};

const isCanonicalProcessExpression = (node: ts.Expression, source: ts.SourceFile): boolean => {
  const value = unwrap(node);
  return (ts.isIdentifier(value) && value.text === "process") ||
    (ts.isPropertyAccessExpression(value) &&
      value.expression.getText(source) === "globalThis" && value.name.text === "process");
};

type ProcessKillAccess = { readonly text: string; readonly mode: "probe" | "forbidden" };

const processKillAccesses = (source: ts.SourceFile): ReadonlyArray<ProcessKillAccess> => {
  const aliases = processAliases(source);
  const accesses: ProcessKillAccess[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedName(node) === "kill" && isProcessExpression(node.expression, source, aliases)
    ) {
      const direct = ts.isPropertyAccessExpression(node) &&
        isCanonicalProcessExpression(node.expression, source) &&
        ts.isCallExpression(node.parent) && node.parent.expression === node;
      const signal = direct ? node.parent.arguments[1] : undefined;
      accesses.push({
        text: node.getText(source),
        mode: direct && signal !== undefined && ts.isNumericLiteral(signal) && signal.text === "0"
          ? "probe"
          : "forbidden",
      });
    }
    if (
      ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
      node.initializer && isProcessExpression(node.initializer, source, aliases) &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText(source) === "kill",
      )
    ) accesses.push({ text: node.getText(source), mode: "forbidden" });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return accesses;
};

const parsedTooling = scanRoots.flatMap(sourceFiles).flatMap((path) => {
  const extension = extname(path);
  if (![".ts", ".tsx", ".js", ".mjs"].includes(extension)) return [];
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return [{ file: relative(root, path), source }];
});

const containsCall = (source: ts.SourceFile, predicate: (call: ts.CallExpression) => boolean): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && predicate(node)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const shutdownRequest = (source: ts.SourceFile): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source).replaceAll(/["']/gu, "") === "method" &&
      ts.isStringLiteral(node.initializer) && node.initializer.text === "server.shutdown") found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const barePidTerminationText = (path: string, text: string): ReadonlyArray<string> => {
  if (path.endsWith(".py")) {
    return text.split("\n").some((line) =>
      /\b(?:os|signal)\.kill\s*\(/u.test(line.replace(/#.*/u, "")),
    ) ? [relative(root, path)] : [];
  }
  if (!path.endsWith(".sh")) return [];
  return text.split("\n").flatMap((line, index) => {
    const code = line.replace(/#.*/u, "").trim();
    return /(?:^|[;&|]\s*)kill(?:\s+-[A-Za-z0-9]+)*\s+[^\s]/u.test(code)
      ? [`${relative(root, path)}:${index + 1}`]
      : [];
  });
};

const barePidTermination = (path: string): ReadonlyArray<string> =>
  barePidTerminationText(path, readFileSync(path, "utf8"));

describe("tooling process-safety architecture", () => {
  it("allows only direct process.kill existence probes in scripts and e2e", () => {
    const violations = parsedTooling.flatMap(({ file, source }) =>
      processKillAccesses(source)
        .filter((access) => access.mode === "forbidden")
        .map((access) => `${file}:${access.text}`),
    ).sort();
    expect(violations).toEqual([]);
  });

  it("has no shell or Python bare-PID termination commands", () => {
    const violations = scanRoots.flatMap(sourceFiles).flatMap(barePidTermination).sort();
    expect(violations).toEqual([]);
  });

  it("launches and drains packaged smoke only through an isolated central process plane", () => {
    const smokeSource = readFileSync(
      join(root, "scripts", "packaged-runtime-smoke.ts"),
      "utf8",
    );
    const source = ts.createSourceFile(
      "packaged-runtime-smoke.ts",
      smokeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(containsCall(source, (call) => call.expression.getText(source) === "createAppProcessPlane"))
      .toBe(true);
    for (const method of [
      "spawnGroup",
      "terminate",
      "forceTerminate",
      "beginShutdown",
      "drainOnQuit",
    ]) {
      expect(containsCall(source, (call) => accessedName(call.expression) === method))
        .toBe(true);
    }
    for (const forbidden of [
      "spawnDetachedProcessGroup",
      "signalOwned",
      "releaseOwned",
      "admitChildProcess",
    ]) {
      expect(containsCall(source, (call) => call.expression.getText(source) === forbidden))
        .toBe(false);
    }
    expect(smokeSource).not.toMatch(
      /\b(?:spawnDetachedProcessGroup|signalOwned|releaseOwned|admitChildProcess|OwnedProcess)\b|from\s+["'][^"']*process-signal["']/u,
    );
    expect(containsCall(source, (call) => accessedName(call.expression) === "spawn")).toBe(false);
    expect(containsCall(source, (call) => accessedName(call.expression) === "kill")).toBe(false);
    expect(containsCall(source, (call) => call.expression.getText(source) === "writeSync"))
      .toBe(true);
    expect(containsCall(source, (call) =>
      call.expression.getText(source) === "process.exit" &&
      call.arguments.length === 1 && call.arguments[0]?.getText(source) === "1"
    )).toBe(true);
  });

  it("shuts down sandbox herdr through its fake-only RPC without pid discovery", () => {
    const source = ts.createSourceFile(
      "launch.ts",
      readFileSync(join(root, "e2e", "harness", "launch.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(shutdownRequest(source)).toBe(true);
    expect(readFileSync(join(root, "e2e", "harness", "launch.ts"), "utf8")).not.toMatch(/\blsof\b/u);
    expect(processKillAccesses(source)).toEqual([]);
  });

  it("rejects process.kill aliases, destructuring, element access, call, and apply", () => {
    const source = ts.createSourceFile(
      "synthetic.ts",
      [
        "const runtime = process;",
        "runtime.kill(123, 0);",
        'process["kill"](123, 0);',
        "process.kill.call(process, 123, 0);",
        "process.kill.apply(process, [123, 0]);",
        "const end = process.kill;",
        "const { kill } = process;",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(processKillAccesses(source)).toEqual([
      { text: "runtime.kill", mode: "forbidden" },
      { text: 'process["kill"]', mode: "forbidden" },
      { text: "process.kill", mode: "forbidden" },
      { text: "process.kill", mode: "forbidden" },
      { text: "process.kill", mode: "forbidden" },
      { text: "{ kill } = process", mode: "forbidden" },
    ]);
  });

  it("rejects real shell and Python PID termination while ignoring comments", () => {
    expect(barePidTerminationText(join(root, "scripts", "synthetic.sh"), "# kill $pid\nkill \"$pid\""))
      .toEqual(["scripts/synthetic.sh:2"]);
    expect(barePidTerminationText(join(root, "scripts", "synthetic.py"), "# os.kill(pid, 9)\nos.kill(pid, 9)"))
      .toEqual(["scripts/synthetic.py"]);
  });
});
