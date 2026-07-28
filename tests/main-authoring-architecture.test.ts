import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(root, "src", "main");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

const filesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });

const stringArgumentsForCalls = (
  path: string,
  callees: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const body = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true);
  const labels: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      callees.has(node.expression.getText(parsed)) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      labels.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return labels;
};

describe("main authoring architecture", () => {
  it("classifies every renderer, pull, portfolio, and delivery mutation ingress", () => {
    const ipcPath = join(mainRoot, "vellum", "ipc.ts");
    const labels = stringArgumentsForCalls(
      ipcPath,
      new Set([
        "runMainAuthoring",
        "runRendererCanvasAuthoring",
        "runRendererWorkAuthoring",
      ]),
    );
    expect([...labels].sort()).toEqual([
      "delivery.message-stamp",
      "ipc.canvas.create",
      "ipc.canvas.delete",
      "ipc.canvas.portfolio",
      "ipc.canvas.write",
      "ipc.work.artifact-publish",
      "ipc.work.message-append",
      "ipc.work.request-create",
      "ipc.work.request-resolve",
      "ipc.work.task-claim",
      "ipc.work.task-create",
      "ipc.work.task-describe",
      "ipc.work.task-transition",
      "startup.canvas.ensure-seed",
    ].sort());
  });

  it("keeps kernel execution out of the authorial canvas write path", () => {
    const kernel = source("src/main/vellum/kernel/service.ts");
    expect(kernel).not.toContain("canvases.mutate(");
    expect(kernel).not.toContain("mainAuthoringGate.run(");
  });

  it("keeps WorkService product ingress closed to the classified IPC and control planes", () => {
    const importers = filesUnder(mainRoot)
      .filter((path) =>
        /import\s+\{[^}]*\bWorkService\b[^}]*\}\s+from/u.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(root, path))
      .filter((path) => path !== "src/main/vellum/work/service.ts")
      .sort();
    expect(importers).toEqual([
      "src/main/vellum/ipc.ts",
      "src/main/vellum/kernel/service.ts",
      "src/main/vellum/work/control.ts",
    ]);

    const control = source("src/main/vellum/work/control.ts");
    expect(control).toContain("mainAuthoringLabelForWorkOperation(req.op)");
    expect(control).toContain("authoringGate.run(authoringLabel, run)");
    expect(control).toContain('workErr(\n              "RuntimeDown"');
  });

  it("keeps actor authority compiled in main and absent from identityless IPC calls", () => {
    const ipc = source("src/main/vellum/ipc.ts");
    const control = source("src/main/vellum/work/control.ts");

    expect(ipc).toContain("resolveProjectedIpcActorRef");
    expect(ipc).toContain("read.right.actorRefs");
    expect(ipc).not.toContain("work.workMessageAppend(");
    expect(ipc).not.toContain("work.workRequestCreate(");
    expect(ipc).not.toContain("work.workArtifactPublish(");
    expect(ipc).toContain('actorIdentityRequired("message append")');
    expect(ipc).toContain('actorIdentityRequired("request create")');
    expect(ipc).toContain('actorIdentityRequired("artifact publish")');
    expect(control).toContain(
      "resolveProcessBoundActorRef(read.actorRefs, caller)",
    );
    expect(control).not.toContain("decoded.right.actor");
    expect(control).not.toContain(
      "decoded.right.actor?.trim() || caller.nodeId",
    );
  });

  it("keeps the final-write authority narrow and out of renderer/preload surfaces", () => {
    const gate = source("src/main/vellum/main-authoring-gate.ts");
    expect(gate).toContain(
      'export type MainAuthoringFinalOperation = "canvas.write" | "canvas.create"',
    );
    expect(gate).toContain("senderId");
    expect(gate).toContain("requestId");

    for (const path of [
      "src/preload/index.ts",
      "src/renderer/App.tsx",
      "src/shared/ipc.ts",
    ]) {
      expect(source(path)).not.toContain("mintFinalWritePermit");
      expect(source(path)).not.toContain("runFinalWrite");
    }
  });

  it("confines the private final-write wire envelope to main IPC and preload", () => {
    const holders = filesUnder(join(root, "src"))
      .filter((path) => readFileSync(path, "utf8").includes("__vellumFinalWrite"))
      .map((path) => relative(root, path))
      .sort();

    expect(holders).toEqual([
      "src/main/vellum/ipc.ts",
      "src/preload/index.ts",
    ]);
    expect(source("src/shared/ipc.ts")).not.toContain("__vellumFinalWrite");
    expect(source("src/renderer/App.tsx")).not.toContain("__vellumFinalWrite");
  });
});
