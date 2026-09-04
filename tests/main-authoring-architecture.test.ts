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
        "runRendererWorkAuthoring",
      ]),
    );
    expect([...labels].sort()).toEqual([
      "delivery.message-stamp",
      "ipc.canvas.create",
      "ipc.canvas.delete",
      "ipc.canvas.portfolio",
      "ipc.canvas.write",
      // Artifact library operator actions (archive / hard-delete).
      "ipc.work.artifact-archive",
      "ipc.work.artifact-delete",
      // Board sink: operator/renderer authoring over the work plane.
      "ipc.work.board-mark-read",
      "ipc.work.board-notify",
      "ipc.work.board-post",
      "ipc.work.board-topic-create",
      "ipc.work.pad-patch",
      "ipc.work.request-resolve",
      "ipc.work.task-claim",
      "ipc.work.task-comment",
      "ipc.work.task-create",
      "ipc.work.task-describe",
      "ipc.work.task-promote",
      "ipc.work.task-respond",
      "ipc.work.task-transition",
      "startup.canvas.ensure-seed",
    ].sort());
  });

  it("routes durable set_flag through classified kernel.flag-mirror mutate only", () => {
    const kernel = source("src/main/vellum/kernel/service.ts");
    // Product law: set_flag / flagOnUnsatisfied write document ether.flags on CC
    // (same truth as toggleFlag), never ghost runtime-only overrides.
    expect(kernel).toContain('mainAuthoringGate.run("kernel.flag-mirror"');
    expect(kernel).toContain("canvases.mutate(");
    expect(kernel).toContain("applyNodeFlag");
    // The phase mirror is gone with the edge field it wrote: phase is derived on
    // every read, so the kernel has no mirror seam to bind and no mirror label.
    expect(kernel).not.toContain("PhaseMirror");
    // No other authoring labels from kernel.
    expect(kernel).not.toContain("kernel.phase-mirror");
    expect(kernel).not.toContain("kernel.claim-tick");
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
      // Operator qualification mints offline Remote Work through WorkService.
      "src/main/vellum/hosts/operator-qualification-work.ts",
      "src/main/vellum/ipc.ts",
      "src/main/vellum/kernel/service.ts",
      "src/main/vellum/work/control.ts",
      // Canvas topology changes emit exactly one compact edge map-change
      // notice per seat; this is the classified authoring listener, not a
      // renderer/control ingress.
      "src/main/vellum/work/edge-map-notify.ts",
    ]);

    const control = source("src/main/vellum/work/control.ts");
    expect(control).toContain("mainAuthoringLabelForWorkOperation(req.op)");
    expect(control).toContain("authoringGate.run(authoringLabel, run)");
    expect(control).toContain('workErr(\n              "RuntimeDown"');
  });

  it("keeps actor authority on the process-bound control plane", () => {
    const ipc = source("src/main/vellum/ipc.ts");
    const preload = source("src/preload/index.ts");
    const contract = source("src/shared/ipc.ts");
    const control = source("src/main/vellum/work/control.ts");

    expect(ipc).toContain("resolveProjectedIpcActorRef");
    // Claim resolves the projected actor at the trusted IPC boundary; other
    // actor operations remain process-bound to the control plane.
    expect(ipc).toContain("resolveRendererActor");
    for (const actorOperation of [
      "workMessageAppend",
      "workRequestCreate",
      "workArtifactPublish",
    ]) {
      expect(ipc).not.toContain(actorOperation);
      expect(preload).not.toContain(actorOperation);
      expect(contract).not.toContain(actorOperation);
    }
    // Operator library actions (not process-bound actor publish).
    expect(ipc).toContain("workArtifactArchive");
    expect(ipc).toContain("workArtifactDelete");
    expect(preload).toContain("workArtifactArchive");
    expect(preload).toContain("workArtifactDelete");
    expect(control).toContain(
      "resolveProcessBoundActorRef(read.actorRefs, caller)",
    );
    expect(control).not.toContain("decoded.success.actor");
    expect(control).not.toContain(
      "decoded.success.actor?.trim() || caller.nodeId",
    );
  });

  it("keeps the quit flush admission to the renderer's own canvas save", () => {
    const gate = source("src/main/vellum/main-authoring-gate.ts");
    const finalFlush = gate.slice(
      gate.indexOf("const FINAL_FLUSH_LABELS"),
      gate.indexOf("export type MainAuthoringWorkClassification"),
    );

    expect(finalFlush).toContain('"ipc.canvas.write"');
    expect(finalFlush).toContain('"ipc.canvas.create"');
    expect(gate).toContain("readonly beginFinalFlush: () => void");
    expect(gate).toContain("readonly close: () => void");
  });
});
