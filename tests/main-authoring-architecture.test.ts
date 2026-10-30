import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
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
  it("classifies every renderer, model, and delivery mutation ingress", () => {
    const ipcPath = join(mainRoot, "junto", "ipc.ts");
    const labels = [
      ...stringArgumentsForCalls(
        ipcPath,
        new Set([
          "runMainAuthoring",
        ]),
      ),
      // Mail receipt admission belongs to the core both shells construct.
      ...stringArgumentsForCalls(
        join(mainRoot, "core-runtime.ts"),
        new Set(["mainAuthoringGate.run"]),
      ),
      // Prompt mail to a seat, sent the same way by the window and the
      // windowless core.
      ...stringArgumentsForCalls(
        join(mainRoot, "junto", "work", "seat-prompt.ts"),
        new Set(["mainAuthoringGate.run"]),
      ),
    ];
    expect([...labels].sort()).toEqual([
      "delivery.message-stamp",
      "ipc.model.command",
      // The renderer's tasks and artifacts, written through the ruler (resource-ipc.ts).
      "ipc.resource.artifact-apply",
      "ipc.resource.task-apply",
      // The operator's comment on a task or an artifact, on the CLI's comment path.
      "ipc.resource.thread-post",
      // Seat collaboration: the operator asks a peer for help, which appends
      // mail to that seat's mailbox.
      "ipc.work.collaboration-ask",
      "ipc.work.message-append",
      // The operator's secret form value goes to the region's vault.
      "ipc.work.signal-secret-put",
      // Mail threads: the operator writes in a seat's thread, mentions included.
      "ipc.work.thread-send",
      // The operator removes a page box comment's shot on every machine.
      "ipc.page-shot.purge",
    ].sort());
  });

  it("gives the kernel no authorial write seam: flags and their mirror are retired", () => {
    const kernel = source("src/main/junto/kernel/service.ts");
    // Operator flags, set_flag and flagOnUnsatisfied are retired, and with them
    // the only kernel path that wrote the authorial document.
    expect(kernel).not.toContain("kernel.flag-mirror");
    expect(kernel).not.toContain("applyNodeFlag");
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
      .filter((path) => path !== "src/main/junto/work/service.ts")
      .sort();
    expect(importers).toEqual([
      // A seat collaboration ask is mail, sent by the core only under the
      // classified ipc.work.collaboration-ask handler in ipc.ts.
      // The window's signal answers are mail, reached only through the
      // classified ipc.work.signal-answer handler (canvas-model group).
      "src/main/core-process/ops/ipc-signals.ts",
      "src/main/core-process/ops/ipc-threads.ts",
      // The window's work reads: topology, a node's comments and mentions, and
      // the work pages, all reads.
      "src/main/core-process/ops/ipc-work.ts",
      // The window's mentions read a node's text through it, read only; the
      // read now carries the services it needs and runs in the core.
      "src/main/core-process/ops/mention-ipc.ts",
      // The automation runner's actions write as the automation's own node
      // (automationActorRef), only on the machine that edits the canvas.
      "src/main/junto/automation/live.ts",
      // The phone's artifact writes rule through the desktop's own resource
      // ruler as the operator, only under the companion.artifact.apply label.
      "src/main/junto/companion/artifact-writes.ts",
      // The phone companion reads a seat's recent-ops Activity through WorkService.
      "src/main/junto/companion/backend.ts",
      // A subject's comments for the phone: the desktop's topology and mailbox
      // reads, and one comment written only under companion.comment (asserted below).
      "src/main/junto/companion/comments.ts",
      // A paired phone's mail and signal answers are operator mail, written only
      // under the companion.* authoring labels (asserted below).
      "src/main/junto/companion/operator-actions.ts",
      // Closed administrative dispatch is still process-bound and gated.
      "src/main/junto/overseer/work.ts",
      // The copies of an answer to the seats it mentions, written only from
      // answerAgentSignal in operator.ts, after the answer stands.
      "src/main/junto/signals/answer-mentions.ts",
      // An operator's signal answer is mail, reached only through the
      // classified ipc.work.signal-answer handler in ipc.ts.
      "src/main/junto/signals/operator.ts",
      // A secret form's value is put where its region declares it, reached
      // only through the classified ipc.work.signal-secret-put handler in
      // ipc.ts; it reads the canvas topology and writes no work.
      "src/main/junto/vault/secret-put.ts",
      "src/main/junto/work/control.ts",
      // Canvas topology changes emit exactly one compact edge map-change
      // notice per seat; this is the classified authoring listener, not a
      // renderer/control ingress.
      "src/main/junto/work/edge-map-notify.ts",
      // Mailboxes held between reads for the thread lists; it only reads.
      "src/main/junto/work/mailbox-cache.ts",
      // Mail threads read the mailboxes; the operator's send runs only under
      // the classified ipc.work.thread-send handler in ipc.ts.
      "src/main/junto/work/operator-threads.ts",
      // A page box comment's shot, read for the operator only, under the
      // trusted preview read in ipc.ts; it reads one row and never writes.
      "src/main/junto/work/page-shot-read.ts",
      // The resource ports read a canvas and a node's comments through it, read
      // only; they sit beside the ports now that the ops file only wires them.
      "src/main/junto/work/resource-ports.ts",
      // Seat waits re-read topology and the selected task; they never mutate.
      "src/main/junto/work/seat-observation-live.ts",
      // Prompt mail to a seat, written only under ipc.work.message-append.
      "src/main/junto/work/seat-prompt.ts",
      // Since your last session, for onboard and junto since; it only reads.
      "src/main/junto/work/seat-since-read.ts",
      // The one resource comment write, reached only from the classified
      // msg.send, msg.reply, task comment and operator thread send paths,
      // and the window's resource thread post.
      "src/main/junto/work/subject-comment.ts",
      // A ruling's notices go out as the actor's mail, only from the ruled task command.
    ]);

    const companion = source("src/main/junto/companion/operator-actions.ts");
    expect(companion).toContain('.run("companion.signal-answer"');
    expect(companion).toContain('.run("companion.signal-dismiss"');
    expect(companion).toContain('.run("companion.signal-reply"');
    // The phone's mail send lives with the thread reads it answers.
    expect(source("src/main/junto/companion/threads.ts")).toContain('.run("companion.mail-send"');
    // The phone's artifact writes run only under their own authoring label.
    expect(source("src/main/junto/companion/artifact-writes.ts")).toContain('.run("companion.artifact.apply"');
    // A phone's comment is written through the desktop's comment path, under its own label.
    expect(source("src/main/junto/companion/comments.ts")).toContain('.run("companion.comment"');

    const control = source("src/main/junto/work/control.ts");
    expect(control).toContain("mainAuthoringLabelForWorkOperation(req.op)");
    expect(control).toContain("authoringGate.run(authoringLabel, run)");
    expect(control).toContain('workErr(\n              "RuntimeDown"');
  });

  it("keeps actor authority on the process-bound control plane", () => {
    const ipc = source("src/main/junto/ipc.ts");
    const preload = source("src/preload/index.ts");
    const contract = source("src/shared/ipc.ts");
    const control = source("src/main/junto/work/control.ts");

    // Main resolves no actor of its own any more: the core's control plane
    // resolves one at its trusted boundary, from the compiled execution
    // projection, so a caller can only be the node it is bound to.
    const workControl = source("src/main/junto/work/control.ts");
    expect(workControl).toContain("resolveProcessBoundActorRef");
    expect(workControl).toContain("only ActorRef carries");
    for (const actorOperation of [
      "workMessageAppend",
      "workRequestCreate",
      "workArtifactPublish",
    ]) {
      expect(ipc).not.toContain(actorOperation);
      expect(preload).not.toContain(actorOperation);
      expect(contract).not.toContain(actorOperation);
    }
    // The old store's library actions left with its table.
    for (const retired of ["workArtifactArchive", "workArtifactDelete"]) {
      expect(ipc).not.toContain(retired);
      expect(preload).not.toContain(retired);
      expect(contract).not.toContain(retired);
    }
    expect(control).toContain(
      "resolveProcessBoundActorRef(read.actorRefs, caller)",
    );
    expect(control).not.toContain("decoded.success.actor");
    expect(control).not.toContain(
      "decoded.success.actor?.trim() || caller.nodeId",
    );
  });

  it("keeps the quit flush admission to the renderer's model commands", () => {
    const gate = source("src/main/junto/main-authoring-gate.ts");
    const finalFlush = gate.slice(
      gate.indexOf("const FINAL_FLUSH_LABELS"),
      gate.indexOf("export type MainAuthoringWorkClassification"),
    );

    expect(finalFlush).toContain('"ipc.model.command"');
    expect(gate).toContain("readonly beginFinalFlush: () => void");
    expect(gate).toContain("readonly close: () => void");
  });
});
