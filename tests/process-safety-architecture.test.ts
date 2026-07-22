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

const callSites = files.flatMap((path): ReadonlyArray<CallSite> => {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      calls.push({
        file: display(path),
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

describe("machine-safety architecture", () => {
  it("keeps every process.kill use on the closed probe/group allowlist", () => {
    const uses = callSites
      .filter(isProcessKill)
      .map((site) => `${site.file}:${processKillMode(site)}`)
      .sort();

    expect(uses).toEqual([
      "src/main/vellum/process-identity.ts:probe",
      "src/main/vellum/process-signal.ts:group",
      "src/main/vellum/process-signal.ts:probe",
    ]);
  });

  it("makes every direct .kill call an explicit reviewed choke point", () => {
    const uses = callSites
      .filter((site) => site.callee.endsWith(".kill") && !isProcessKill(site))
      .map((site) => `${site.file}:${site.callee}`)
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
      expect(readFileSync(join(root, name), "utf8"), name).toContain(
        "admitChildProcess",
      );
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

    const detachedTrue = files
      .filter((path) => /\bdetached\s*:\s*true\b/u.test(readFileSync(path, "utf8")))
      .map(display)
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

    const sshSources = files
      .filter((path) => display(path).startsWith("src/main/vellum/ssh/"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(sshSources).not.toMatch(
      /(?:NodeCommandExecutor|NodeContext|CommandExecutor\.make|commandExecutor)/u,
    );
  });
});
