import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(root, "src", "main");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });

const files = sourceFiles(mainRoot);
const display = (path: string): string => relative(root, path);

type CallSite = {
  readonly file: string;
  readonly callee: string;
  readonly call: ts.CallExpression;
  readonly source: ts.SourceFile;
};

const parsedSources = files.map((path) => ({
  file: display(path),
  path,
  source: ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ),
}));

const callSites = parsedSources.flatMap(({ file, source }): ReadonlyArray<CallSite> => {
  const calls: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      calls.push({
        file,
        callee: node.expression.getText(source),
        call: node,
        source,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
});

const isProcessKill = (site: CallSite): boolean =>
  site.callee === "process.kill" || site.callee === "globalThis.process.kill";

const processKillMode = (site: CallSite): "group" | "probe" | "forbidden" => {
  const [target, signal] = site.call.arguments;
  if (signal && ts.isNumericLiteral(signal) && signal.text === "0") return "probe";
  if (
    target &&
    ts.isPrefixUnaryExpression(target) &&
    target.operator === ts.SyntaxKind.MinusToken
  ) {
    return "group";
  }
  return "forbidden";
};

const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};

const processAliases = (source: ts.SourceFile): ReadonlySet<string> => {
  const aliases = new Set(["process"]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const value = unwrap(node.initializer);
        const isGlobal =
          (ts.isIdentifier(value) && aliases.has(value.text)) ||
          (ts.isPropertyAccessExpression(value) &&
            value.expression.getText(source) === "globalThis" &&
            value.name.text === "process");
        if (isGlobal && !aliases.has(node.name.text)) {
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
  return (
    (ts.isIdentifier(value) && aliases.has(value.text)) ||
    (ts.isPropertyAccessExpression(value) &&
      value.expression.getText(source) === "globalThis" &&
      value.name.text === "process")
  );
};

const accessedName = (node: ts.Node): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
};

type AccessSite = {
  readonly file: string;
  readonly text: string;
  readonly mode: "direct" | "forbidden-reference";
  readonly call?: CallSite;
};

const processKillAccesses = parsedSources.flatMap(
  ({ file, source }): ReadonlyArray<AccessSite> => {
    const aliases = processAliases(source);
    const accesses: AccessSite[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessedName(node) === "kill" &&
        isProcessExpression(node.expression, source, aliases)
      ) {
        const parent = node.parent;
        const direct =
          ts.isPropertyAccessExpression(node) &&
          ts.isCallExpression(parent) &&
          parent.expression === node;
        accesses.push({
          file,
          text: node.getText(source),
          mode: direct ? "direct" : "forbidden-reference",
          ...(direct
            ? {
                call: {
                  file,
                  callee: node.getText(source),
                  call: parent as ts.CallExpression,
                  source,
                },
              }
            : {}),
        });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isProcessExpression(node.initializer, source, aliases) &&
        node.name.elements.some(
          (element) => (element.propertyName ?? element.name).getText(source) === "kill",
        )
      ) {
        accesses.push({
          file,
          text: node.getText(source),
          mode: "forbidden-reference",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return accesses;
  },
);

const directKillAccesses = parsedSources.flatMap(
  ({ file, source }): ReadonlyArray<AccessSite> => {
    const processNodes = new Set(
      processKillAccesses
        .filter((access) => access.file === file)
        .map((access) => access.text),
    );
    const accesses: AccessSite[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessedName(node) === "kill" &&
        !processNodes.has(node.getText(source))
      ) {
        const parent = node.parent;
        const direct =
          ts.isPropertyAccessExpression(node) &&
          ts.isCallExpression(parent) &&
          parent.expression === node;
        accesses.push({
          file,
          text: node.getText(source),
          mode: direct ? "direct" : "forbidden-reference",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return accesses;
  },
);

const importedSpawnNames = (source: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:child_process"
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "spawn") {
        names.add(element.name.text);
      }
    }
  }
  return names;
};

const unsafeSpawnReferences = parsedSources.flatMap(({ file, source }) => {
  const names = importedSpawnNames(source);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const importBinding = ts.isImportSpecifier(node.parent);
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!importBinding && !directCall) violations.push(`${file}:${node.getText(source)}`);
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedName(node) === "spawn"
    ) {
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!directCall) violations.push(`${file}:${node.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
});

describe("machine-safety architecture", () => {
  it("keeps every process.kill use on the closed probe/group allowlist", () => {
    const uses = processKillAccesses
      .map((access) =>
        access.mode === "direct" && access.call
          ? `${access.file}:${processKillMode(access.call)}`
          : `${access.file}:${access.mode}:${access.text}`,
      )
      .sort();

    expect(uses).toEqual([
      "src/main/vellum/process-identity.ts:probe",
      "src/main/vellum/process-signal.ts:group",
      "src/main/vellum/process-signal.ts:probe",
    ]);
  });

  it("makes every direct .kill call an explicit reviewed choke point", () => {
    const uses = directKillAccesses
      .map((access) =>
        access.mode === "direct"
          ? `${access.file}:${access.text}`
          : `${access.file}:${access.mode}:${access.text}`,
      )
      .sort();

    expect(uses).toEqual([
      "src/main/vellum/process-signal.ts:rec.child.kill",
      "src/main/vellum/term/control-server.ts:host.kill",
      "src/main/vellum/term/ipc.ts:router.kill",
      "src/main/vellum/term/local-host.ts:child.kill",
      "src/main/vellum/term/local-host.ts:p.kill",
      "src/main/vellum/term/router.ts:c.kill",
      "src/main/vellum/term/router.ts:this.local.kill",
    ]);
  });

  it("keeps asynchronous spawn sites on a reviewed lifetime inventory", () => {
    expect(unsafeSpawnReferences).toEqual([]);

    const spawnCallees = new Set(["spawn", "cpSpawn", "nodePty.spawn"]);
    const uses = callSites
      .filter((site) => spawnCallees.has(site.callee))
      .map((site) => `${site.file}:${site.callee}`)
      .sort();

    expect(uses).toEqual([
      "src/main/services/codex.ts:spawn",
      "src/main/services/process.ts:spawn",
      "src/main/vellum/herdr/plane.ts:spawn",
      "src/main/vellum/herdr/plane.ts:spawn",
      "src/main/vellum/hermes/plane.ts:spawn",
      "src/main/vellum/hosts/deploy-remote.ts:spawn",
      "src/main/vellum/process-signal.ts:spawn",
      "src/main/vellum/term/local-host.ts:cpSpawn",
      "src/main/vellum/term/local-host.ts:nodePty.spawn",
    ]);

    // These direct producers terminate children and therefore must mint their
    // child-only capability in the same module, immediately beside spawn.
    for (const name of [
      "src/main/services/codex.ts",
      "src/main/services/process.ts",
      "src/main/vellum/hermes/plane.ts",
      "src/main/vellum/hosts/deploy-remote.ts",
      "src/main/vellum/term/local-host.ts",
    ]) {
      const admissions = callSites.filter(
        (site) => site.file === name && site.callee === "admitChildProcess",
      );
      expect(admissions, name).toHaveLength(1);
    }
  });

  it("freezes the two intentional detached-process-group consumers", () => {
    const uses = callSites
      .filter((site) => site.callee === "spawnDetachedProcessGroup")
      .map((site) => site.file)
      .sort();

    expect(uses).toEqual([
      "src/main/vellum/adapters/exec.ts",
      "src/main/vellum/ssh/process-spawner.ts",
    ]);

    const detachedTrue = parsedSources
      .flatMap(({ file, source }) => {
        let count = 0;
        const visit = (node: ts.Node): void => {
          if (
            ts.isPropertyAssignment(node) &&
            node.name.getText(source).replaceAll(/["']/gu, "") === "detached" &&
            node.initializer.kind === ts.SyntaxKind.TrueKeyword
          ) count += 1;
          ts.forEachChild(node, visit);
        };
        visit(source);
        return Array.from({ length: count }, () => file);
      })
      .sort();
    expect(detachedTrue).toEqual([
      "src/main/vellum/herdr/plane.ts",
      "src/main/vellum/process-signal.ts",
    ]);
  });

  it("does not expose bypass admission or a second Effect group-kill plane", () => {
    const processSignal = readFileSync(
      join(root, "src/main/vellum/process-signal.ts"),
      "utf8",
    );
    expect(processSignal).not.toMatch(
      /\b(?:admitSpawnedProcess|registerOwnedProcess|signalChildHandleOnly)\b/u,
    );

    const forbiddenEffectImports = parsedSources.flatMap(({ file, source }) => {
      if (!file.startsWith("src/main/vellum/ssh/")) return [];
      return source.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          return [];
        }
        const specifier = statement.moduleSpecifier.text;
        const forbiddenModule =
          specifier === "@effect/platform-node" ||
          /\/(?:NodeCommandExecutor|NodeContext|CommandExecutor)$/u.test(specifier);
        const forbiddenBinding = statement.importClause?.getText(source).match(
          /\b(?:NodeCommandExecutor|NodeContext|CommandExecutor)\b/u,
        );
        return forbiddenModule || forbiddenBinding ? [`${file}:${specifier}`] : [];
      });
    });
    expect(forbiddenEffectImports).toEqual([]);
  });
});
