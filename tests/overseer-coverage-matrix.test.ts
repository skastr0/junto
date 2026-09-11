import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string =>
  readFileSync(join(root, relative), "utf8");

/** Frozen `OVERSEER_OPERATION_NAMES` from the shared contract worker. */
const FROZEN_OPERATIONS = [
  "status",
  "canvas.list",
  "canvas.read",
  "canvas.create",
  "canvas.delete",
  "canvas.digest",
  "canvas.render",
  "canvas.screenshot",
  "node.list",
  "node.get",
  "node.create",
  "node.configure",
  "node.move",
  "node.resize",
  "node.delete",
  "edge.list",
  "edge.get",
  "edge.verbs",
  "edge.connect",
  "edge.configure",
  "edge.disconnect",
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.describe",
  "tasks.update",
  "tasks.show",
  "tasks.rules",
  "tasks.check",
  "tasks.promote",
  "tasks.comment",
  "tasks.respond",
  "request.list",
  "request.get",
  "request.create",
  "request.resolve",
  "request.comment",
  "artifact.list",
  "artifact.get",
  "artifact.publish",
  "artifact.archive",
  "artifact.delete",
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "msg.react",
  "board.list",
  "board.create-topic",
  "board.post",
  "board.mark-read",
  "board.tags",
  "board.notify",
  "pad.read",
  "pad.patch",
  "pad.digest",
  "pad.render",
  "pad.look-here",
  "pad.get",
  "pad.tagged",
  "sheet.read",
  "sheet.configure",
  "content.ingest",
  "content.path",
  "content.stat",
  "content.materialize",
  "agent.list",
  "agent.get",
  "agent.reseat",
  "agent.start",
  "agent.wake",
  "agent.prompt",
  "agent.output",
  "agent.interrupt",
  "agent.stop",
  "terminal.list",
  "terminal.get",
  "terminal.start",
  "terminal.input",
  "terminal.output",
  "terminal.resize",
  "terminal.interrupt",
  "terminal.stop",
  "page.list",
  "page.get",
  "page.open",
  "page.goto",
  "page.eval",
  "page.screenshot",
  "page.close",
  "page.stop",
  "scheduler.fire",
  "scheduler.status",
  "scheduler.configure",
  "git.status",
  "git.log",
  "git.show",
] as const;

const FROZEN_READ_ONLY = [
  "status",
  "canvas.list",
  "canvas.read",
  "canvas.digest",
  "canvas.render",
  "node.list",
  "node.get",
  "edge.list",
  "edge.get",
  "edge.verbs",
  "tasks.list",
  "tasks.show",
  "tasks.rules",
  "request.list",
  "request.get",
  "artifact.list",
  "artifact.get",
  "board.list",
  "board.tags",
  "pad.digest",
  "pad.render",
  "pad.get",
  "pad.tagged",
  "sheet.read",
  "content.path",
  "content.stat",
  "agent.list",
  "agent.get",
  "agent.output",
  "terminal.list",
  "terminal.get",
  "terminal.output",
  "page.list",
  "page.get",
  "scheduler.status",
  "git.status",
  "git.log",
  "git.show",
] as const;

const quotedOps = (matrix: string): ReadonlyArray<string> =>
  [...matrix.matchAll(/^\| `([^`]+)` \| (read|mutation) \|/gmu)].map(
    (match) => match[1],
  );

const collapsed = (input: string): string => input.replace(/\s+/gu, " ");

describe("overseer coverage matrix", () => {
  it("inventories every frozen wire operation without claiming handlers", () => {
    const matrix = read("docs/overseer-coverage-matrix.md");
    expect(collapsed(matrix)).toContain("This file does not claim handlers");
    expect(quotedOps(matrix)).toEqual([...FROZEN_OPERATIONS]);
    expect(FROZEN_OPERATIONS).toHaveLength(97);
    expect(collapsed(matrix)).toContain("`page.eval` is a mutation");
    expect(matrix).toContain("canvasOverseerSet");
    expect(matrix).toContain("tests/overseer-admission.test.ts");
  });

  it("marks the frozen read-only set and treats page.eval as mutation", () => {
    const matrix = read("docs/overseer-coverage-matrix.md");
    for (const operation of FROZEN_READ_ONLY) {
      expect(matrix).toContain(`| \`${operation}\` | read |`);
    }
    expect(matrix).toContain("| `page.eval` | mutation |");
    expect(matrix).toContain("| `canvas.screenshot` | mutation |");
    expect(matrix).toContain("| `msg.list` | mutation |");
    expect(matrix).toContain("| `pad.read` | mutation |");
  });

  it("tracks the seven key risks as missing until peers land proofs", () => {
    const matrix = read("docs/overseer-coverage-matrix.md");
    for (const risk of [
      "Stale UI save/undo restoring revoked authority",
      "No-edge ordinary vs overseer distinction",
      "Toggle copied aliases",
      "Self-retirement via canvas delete/kind/binding",
      "Remote source impersonation",
      "Uncertain completion, no automatic replay",
      "Viewport invariance",
    ]) {
      expect(matrix).toContain(risk);
      expect(matrix).toMatch(new RegExp(`${risk}[\\s\\S]*?\\| missing \\|`, "u"));
    }
  });
});

describe("overseer doctrine alignment", () => {
  it("narrows canvas authorship to overseers and keeps ordinary edge scope", () => {
    const agents = collapsed(read("AGENTS.md"));
    const doctrine = collapsed(read("docs/security-doctrine.md"));
    const physics = collapsed(read("docs/architecture-factory-physics.md"));
    const plan = collapsed(read("docs/overseer-plan.md"));

    expect(agents).toContain("Ordinary agents never write the canvas.");
    expect(agents).not.toContain("**Agents never write the canvas.**");
    expect(agents).toContain("Only humans grant or revoke");
    expect(agents).toContain("Factory pause and play have no bearing");
    expect(agents).toContain(
      "cannot delete its own seat or move the operator viewport",
    );
    expect(agents).toContain("a Remote does not author projection");
    expect(agents).toContain(
      "does not receive the operator socket, fleet enrollment, or credentials",
    );

    expect(doctrine).toContain("ordinary agents never write the canonical canvas");
    expect(doctrine).toContain(
      "`pair`, `configure`, `project`, `report`, `status`, and `overseer`",
    );
    expect(doctrine).not.toMatch(/exactly five verbs/u);
    expect(doctrine).toContain("never automatically replays the mutation");
    expect(doctrine).toContain("Copied aliases do not inherit the grant");

    expect(physics).toContain(
      "overseer grant is a separate human seat toggle, not an edge",
    );
    expect(physics).toContain("Can an ordinary agent");
    expect(physics).toContain("never the operator socket");

    expect(plan).toContain("Settled authority decisions");
    expect(plan).toContain("Factory pause and play have no bearing");
    expect(plan).not.toContain(
      "implementation blocked on the three authority decisions",
    );
  });
});
