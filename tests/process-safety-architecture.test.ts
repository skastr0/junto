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
    const aliases = processAliases(source);
    const accesses: AccessSite[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessedName(node) === "kill" &&
        !isProcessExpression(node.expression, source, aliases)
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
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
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

type SpawnAccess = {
  readonly text: string;
  readonly mode: "direct" | "forbidden-reference";
};

const spawnAccesses = (source: ts.SourceFile): ReadonlyArray<SpawnAccess> => {
  const named = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:child_process"
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "spawn") {
          named.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }

  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = unwrap(node.initializer);
        if (ts.isIdentifier(value) && namespaces.has(value.text) && !namespaces.has(node.name.text)) {
          namespaces.add(node.name.text);
          aliasesChanged = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }

  const accesses: SpawnAccess[] = [];
  const visit = (node: ts.Node): void => {
    const namedSpawn = ts.isIdentifier(node) && named.has(node.text);
    const namespaceSpawn =
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedName(node) === "spawn" &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text);
    if (namedSpawn || namespaceSpawn) {
      const importBinding = ts.isImportSpecifier(node.parent);
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!importBinding) {
        accesses.push({
          text: node.getText(source),
          mode: directCall ? "direct" : "forbidden-reference",
        });
      }
    }
    const initializer = ts.isVariableDeclaration(node) && node.initializer
      ? unwrap(node.initializer)
      : undefined;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      initializer &&
      ts.isIdentifier(initializer) &&
      namespaces.has(initializer.text) &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText(source) === "spawn",
      )
    ) {
      accesses.push({ text: node.getText(source), mode: "forbidden-reference" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return accesses;
};

const unsafeSpawnReferences = parsedSources.flatMap(({ file, source }) =>
  spawnAccesses(source)
    .filter((access) => access.mode === "forbidden-reference")
    .map((access) => `${file}:${access.text}`),
);

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
      "src/main/vellum/app-process-plane.ts:forbidden-reference:child.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:pty.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:record.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:record.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:record.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:record.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:record.kill",
      "src/main/vellum/app-process-plane.ts:forbidden-reference:record.kill",
      "src/main/vellum/process-signal.ts:forbidden-reference:child.kill",
      "src/main/vellum/process-signal.ts:rec.child.kill",
      "src/main/vellum/term/control-server.ts:host.kill",
      "src/main/vellum/term/ipc.ts:router.kill",
      "src/main/vellum/term/router.ts:c.kill",
      "src/main/vellum/term/router.ts:this.local.kill",
      // Owned child only: codesign/plutil admit timeout.
      "src/main/vellum/update/admit-mac-app.ts:child.kill",
    ]);
  });

  it("keeps asynchronous spawn sites on a reviewed lifetime inventory", () => {
    expect(unsafeSpawnReferences).toEqual([
      "src/main/vellum/app-process-plane.ts:spawn",
    ]);

    const uses = [
      ...parsedSources.flatMap(({ file, source }) =>
        spawnAccesses(source)
          .filter((access) => access.mode === "direct")
          .map((access) => `${file}:${access.text}`),
      ),
      ...callSites
        .filter((site) => site.callee === "nodePty.spawn")
        .map((site) => `${site.file}:${site.callee}`),
    ]
      .sort();

    expect(uses).toEqual([
      "src/main/vellum/app-process-plane.ts:nodePty.spawn",
      "src/main/vellum/app-process-plane.ts:spawn",
      "src/main/vellum/app-process-plane.ts:spawn",
      "src/main/vellum/process-signal.ts:spawn",
      // Owned children only: codesign admit, ditto extract.
      "src/main/vellum/update/admit-mac-app.ts:spawn",
      "src/main/vellum/update/staging.ts:spawn",
    ]);

    // Raw child admission is now centralized in the app process plane. Other
    // modules must route through that plane instead of minting authority
    // beside their own spawn calls.
    for (const name of [
      "src/main/vellum/app-process-plane.ts",
    ]) {
      const admissions = callSites.filter(
        (site) => site.file === name && site.callee === "admitChildProcess",
      );
      expect(admissions.length, name).toBeGreaterThan(0);
    }
  });

  it("freezes detached process-group creation inside the central process plane", () => {
    const uses = callSites
      .filter((site) => site.callee === "spawnDetachedProcessGroup")
      .map((site) => site.file)
      .sort();

    expect(uses).toEqual([
      "src/main/vellum/app-process-plane.ts",
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
      "src/main/vellum/app-process-plane.ts",
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

    const approvedSshExternalImports = new Set([
      "@effect/platform/Command",
      "@effect/platform/FileSystem",
      "@effect/platform-node/NodeFileSystem",
      "@effect/platform-node/NodeSink",
      "@effect/platform-node/NodeStream",
      // live.ts resolves controlDir under the operator home; no second spawn plane.
      "@shared/vellum-home",
      "effect",
      "node:crypto",
      "node:os",
      "node:path",
    ]);
    const unapprovedSshImports = parsedSources.flatMap(({ file, source }) => {
      if (!file.startsWith("src/main/vellum/ssh/")) return [];
      return source.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          return [];
        }
        const specifier = statement.moduleSpecifier.text;
        return specifier.startsWith(".") || approvedSshExternalImports.has(specifier)
          ? []
          : [`${file}:${specifier}`];
      });
    });
    expect(unapprovedSshImports).toEqual([]);
  });

  it("rejects spawn and child-kill reference bypasses before they reach the inventory", () => {
    const source = ts.createSourceFile(
      "synthetic.ts",
      [
        'import { spawn as launch } from "node:child_process";',
        'import * as childProcess from "node:child_process";',
        "launch(\"ok\");",
        "childProcess.spawn(\"ok\");",
        "const childProcessAlias = childProcess;",
        "childProcessAlias.spawn(\"ok\");",
        "launch.call(undefined, \"bad\");",
        "childProcess.spawn.apply(undefined, [\"bad\"]);",
        "accept(launch);",
        "const { spawn } = childProcess;",
        "const stop = child.kill;",
        "const { kill } = child;",
        "child.kill.call(child, \"SIGTERM\");",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(spawnAccesses(source)).toEqual([
      { text: "launch", mode: "direct" },
      { text: "childProcess.spawn", mode: "direct" },
      { text: "childProcessAlias.spawn", mode: "direct" },
      { text: "launch", mode: "forbidden-reference" },
      { text: "childProcess.spawn", mode: "forbidden-reference" },
      { text: "launch", mode: "forbidden-reference" },
      { text: "{ spawn } = childProcess", mode: "forbidden-reference" },
    ]);

    const killReferences: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessedName(node) === "kill" &&
        !isProcessExpression(node.expression, source, processAliases(source))
      ) {
        const direct = ts.isPropertyAccessExpression(node) &&
          ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!direct) killReferences.push(node.getText(source));
      }
      if (
        ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
        node.name.elements.some(
          (element) => (element.propertyName ?? element.name).getText(source) === "kill",
        )
      ) killReferences.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(killReferences).toEqual(["child.kill", "{ kill } = child", "child.kill"]);
  });
});
