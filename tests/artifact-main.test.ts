import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";
import { ActorSeatId } from "../src/shared/actor-seat";
import { type ArtifactBody, type ArtifactOp, type ArtifactVersion, emptyBody } from "../src/shared/artifact";
import {
  artifactDomain,
  type ArtifactEntry,
  type ArtifactFact,
  type ArtifactState,
  emptyArtifactState,
} from "../src/shared/artifact-domain";
import { ARTIFACT_OPS, type ArtifactShowResult, type ArtifactWriteResult } from "../src/shared/artifact-control";
import { ARTIFACTS_ENABLED } from "../src/shared/features";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import { emptyRuled, type ResourceCommand, rule, type Ruled } from "../src/shared/resource-command";
import type { SubjectCommentInput } from "../src/shared/subject-comment";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId } from "../src/shared/work-ids";
import { artifactLink } from "../src/shared/artifact-link";
import { mentionKey } from "../src/shared/mention";
import { artifactLabelsMatch } from "../src/shared/artifact-labels";
import {
  bodyFor,
  handleArtifactOp,
  type ArtifactCaller,
  type ArtifactPorts,
} from "../src/main/junto/work/artifact-control";
import { artifactBodyRef } from "../src/main/junto/work/artifact-repository";

const at = (id: string, kind: string, x: number, y: number, extra: Record<string, unknown> = {}, width = 50, height = 50) =>
  ({ id: asNodeId(id), kind, x, y, width, height, ...extra }) as unknown as Node;

// Region CLI holds seat S1 and the Artifacts node AR; sibling region P holds
// seat SP and its own Artifacts node AP. Both nodes are named "Shelf".
const nodes = [
  at("CLI", "region", 10, 10, { label: "CLI" }, 800, 800),
  at("S1", "agent", 20, 20, { label: "cli-identity", agentKey: "a" }),
  at("AR", "artifacts", 200, 20, { label: "Shelf" }),
  at("TN", "task", 300, 20, { name: "CLI tasks" }),
  at("S2", "agent", 400, 20, { label: "cli-protocol", agentKey: "b" }),
  at("P", "region", 1000, 10, { label: "Product" }, 400, 400),
  at("SP", "agent", 1010, 20, { label: "product-shell", agentKey: "c" }),
  at("AP", "artifacts", 1100, 20, { label: "Shelf" }),
  at("TP", "task", 1200, 20, { name: "Product tasks" }),
];
const canvas = { nodes: new Map(nodes.map((node) => [node.id, node])), wires: new Map() } as unknown as Canvas;

const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";
const OP2 = "01M5ESM1XHCJ7JYJDBC37MREC0";
const NEW = "01M5ESMQ2ZT55QZ073EWPH10SG";
const v = (n: number) => n as ArtifactVersion;
const TASK_HERE = ItemId.make("01M5ETAKR8YSPP5Y22H4KH2YMW");
const TASK_AWAY = ItemId.make("01M5ETAKR8YSPP5Y22H4KH2YMX");

const caller = (nodeId: string): ArtifactCaller => ({
  canvas,
  canvasName: "factory",
  actor: { kind: "seat", seatId: ActorSeatId.make(`seat_${"a".repeat(64)}`), nodeId: asNodeId(nodeId) },
});

/** Ports over the real ruler and artifact domain, in memory. */
const memoryPorts = () => {
  let ruled: Ruled<ArtifactState, ArtifactFact> = emptyRuled(emptyArtifactState());
  const bodies = new Map<string, ArtifactBody>();
  const submitted: Array<ResourceCommand<ArtifactOp>> = [];
  const comments: Array<{ input: SubjectCommentInput; people: ReadonlyArray<string> }> = [];
  const pulls: Array<Parameters<ArtifactPorts["pull"]>[0]> = [];
  const domain = artifactDomain({ now: () => 1_000, bodyRef: artifactBodyRef });
  const entries = (): ReadonlyArray<ArtifactEntry> => [...ruled.state.values()];
  const ports: ArtifactPorts = {
    nodes: (c) => [...c.nodes.values()].filter((node) => node.kind === "artifacts"),
    list: (_canvas, query) => {
      const found = entries()
        .map((entry) => entry.artifact)
        .filter((a) => query.nodeIds.includes(a.nodeId) && a.archived === query.archived && (query.type === undefined || a.type === query.type))
        // The repository filters in SQL; the memory store keeps the one rule it mirrors.
        .filter((a) => artifactLabelsMatch(a.labels, query.labels ?? []));
      return Effect.succeed({ artifacts: found.slice(0, query.limit), more: found.length > query.limit });
    },
    head: (_canvas, id) =>
      Effect.succeed(
        Option.fromNullishOr(ruled.state.get(id)).pipe(Option.map(({ artifact, body, bodyRef }) => ({ artifact, bodyRef, body: body ?? bodies.get(`${id}@${artifact.version}`)! }))),
      ),
    body: (_canvas, id, version) =>
      Effect.succeed(Option.fromNullishOr(bodies.get(`${id}@${version}`)).pipe(Option.map((body) => ({ body, bodyRef: artifactBodyRef(body) })))),
    pull: (input) => Effect.sync(() => void pulls.push(input)),
    history: () => Effect.succeed({ versions: [], more: false }),
    comment: (input, context) => {
      comments.push({ input, people: context.people });
      return input.text === "refuse"
        ? Effect.fail({ type: "ScopeError", message: "no", details: { reason: "not_in_reach", retryable: false } })
        : Effect.succeed({ threadId: "T1" as never, messageId: "M1" as never, notified: [asNodeId("S1")] });
    },
    taskNode: (_canvas, taskId) =>
      Effect.succeed(taskId === TASK_HERE ? Option.some(asNodeId("TN")) : taskId === TASK_AWAY ? Option.some(asNodeId("TP")) : Option.none()),
    submit: (command, context) => {
      submitted.push(command);
      const next = rule(domain, ruled, "mini" as InstallationId, command, context);
      ruled = next.ruled;
      if (next.ruling.kind === "refused") {
        return Effect.succeed({ kind: "refused", opId: command.opId, error: next.ruling.error, root: next.ruling.root });
      }
      const entry = ruled.state.get(command.target.itemId!)!;
      if (entry.body !== null) bodies.set(`${entry.artifact.artifactId}@${entry.artifact.version}`, entry.body);
      return Effect.succeed({
        kind: "applied",
        opId: command.opId,
        artifactId: entry.artifact.artifactId,
        version: entry.artifact.version,
        facts: next.ruling.facts,
      });
    },
  };
  return { ports, submitted, comments, pulls };
};

const run = (ports: ArtifactPorts, op: Parameters<typeof handleArtifactOp>[0], args: unknown, who = "S1") =>
  Effect.runSyncExit(handleArtifactOp(op, args, caller(who), ports));

const ok = <A>(exit: Exit.Exit<unknown, WorkErrorBody>): A => {
  if (Exit.isFailure(exit)) throw new Error(JSON.stringify(exit.cause));
  return exit.value as A;
};

const failure = (exit: Exit.Exit<unknown, WorkErrorBody>): WorkErrorBody => {
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined || error._tag !== "Fail") throw new Error(String(exit.cause));
  return error.error;
};

const createDoc = (ports: ArtifactPorts, extra: Record<string, unknown> = {}) =>
  ok<ArtifactWriteResult>(run(ports, "artifact.create", { opId: OP, artifactId: NEW, type: "document", title: "Notes", ...extra }));

describe.runIf(ARTIFACTS_ENABLED)("junto artifact in main", () => {
  it("creates on the one Artifacts node in reach, with an empty body, as the caller", () => {
    const { ports, submitted } = memoryPorts();
    expect(createDoc(ports)).toEqual({ disposition: "applied", opId: OP, artifactId: NEW, version: 1 });
    expect(submitted[0]).toMatchObject({
      opId: OP,
      canvasName: "factory",
      actor: { kind: "seat", nodeId: "S1" },
      target: { kind: "artifact", nodeId: "AR", itemId: NEW },
      op: { op: "create", title: "Notes", body: emptyBody("document") },
    });
  });

  it("matches a node name among the nodes in reach only, and hints only those", () => {
    const { ports } = memoryPorts();
    // "Shelf" names AR and AP, but only AR is in S1's reach: not ambiguous.
    expect(createDoc(ports, { node: "Shelf" })).toMatchObject({ disposition: "applied" });
    const refused = failure(run(ports, "artifact.list", { node: "AP" }));
    expect(refused).toMatchObject({ type: "UnknownTarget" });
    expect(JSON.stringify(refused)).not.toContain("Product");
  });

  it("shows the head as text and body, and a past version on ask", () => {
    const { ports } = memoryPorts();
    createDoc(ports, { body: { markdown: "# one" } });
    ok(run(ports, "artifact.edit", { opId: OP2, artifact: NEW, baseVersion: 1, body: { markdown: "# two" } }));
    expect(ok(run(ports, "artifact.show", { artifact: NEW }))).toMatchObject({ version: 2, text: "# two" });
    expect(ok(run(ports, "artifact.show", { artifact: NEW, version: 1 }))).toMatchObject({ version: 1, text: "# one" });
    expect(failure(run(ports, "artifact.show", { artifact: NEW, version: 9 }))).toMatchObject({
      type: "UnknownTarget",
      details: { expected: 2 },
    });
  });

  it("reads an artifact out of reach as unknown, never as out of reach", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    expect(failure(run(ports, "artifact.show", { artifact: NEW }, "SP"))).toMatchObject({ type: "UnknownTarget" });
    expect(ok<{ artifacts: unknown[] }>(run(ports, "artifact.list", {}, "SP")).artifacts).toEqual([]);
  });

  it("refuses a stale replace with the head and the opId", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    ok(run(ports, "artifact.edit", { opId: OP2, artifact: NEW, baseVersion: 1, body: { markdown: "a" } }));
    const stale = failure(
      run(ports, "artifact.edit", { opId: "01M5ESM1XHCJ7JYJDBC37MREC1", artifact: NEW, baseVersion: 1, body: { markdown: "b" } }),
    );
    expect(stale.details).toMatchObject({ reason: "stale", expected: 2, opId: "01M5ESM1XHCJ7JYJDBC37MREC1", retryable: true });
  });

  it("patches with the artifact's own type, and refuses patching a link", () => {
    const { ports, submitted } = memoryPorts();
    ok(run(ports, "artifact.create", { opId: OP, artifactId: NEW, type: "sheet", title: "Budget" }));
    ok(run(ports, "artifact.edit", {
      opId: OP2,
      artifact: NEW,
      baseVersion: 1,
      patches: [{ op: "cell", rowId: "r1", columnId: "c1", value: "4" }],
    }));
    expect(submitted[1]?.op).toMatchObject({ op: "edit", edit: { kind: "patch", type: "sheet", baseVersion: 1 } });

    const link = memoryPorts();
    ok(run(link.ports, "artifact.create", { opId: OP, artifactId: NEW, type: "link", title: "Site", body: { url: "https://example.com" } }));
    expect(failure(run(link.ports, "artifact.edit", { opId: OP2, artifact: NEW, baseVersion: 1, patches: [{}] }))).toMatchObject({
      type: "InputError",
      details: { path: "patches" },
    });
  });

  it("links only tasks in reach, and reads one out of reach as unknown", () => {
    const { ports, submitted } = memoryPorts();
    expect(createDoc(ports, { taskIds: [TASK_HERE] })).toMatchObject({ disposition: "applied" });
    expect(submitted[0]?.op).toMatchObject({ taskIds: [TASK_HERE] });
    const away = memoryPorts();
    expect(failure(run(away.ports, "artifact.create", { opId: OP, artifactId: NEW, type: "document", title: "N", taskIds: [TASK_HERE, TASK_AWAY] })))
      .toMatchObject({ type: "UnknownTarget", details: { path: "taskIds[1]" } });
    expect(away.submitted).toEqual([]);
  });

  it("wants exactly one of body and patches", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    expect(failure(run(ports, "artifact.edit", { opId: OP2, artifact: NEW, baseVersion: 1 }))).toMatchObject({ type: "InputError" });
  });

  it("archives and restores, and an archived artifact takes no edit", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    ok(run(ports, "artifact.archive", { opId: OP2, artifact: NEW }));
    expect(ok<{ artifacts: unknown[] }>(run(ports, "artifact.list", { archived: true })).artifacts).toHaveLength(1);
    const edit = failure(run(ports, "artifact.edit", { opId: "01M5ESM1XHCJ7JYJDBC37MREC1", artifact: NEW, baseVersion: 2, body: { markdown: "x" } }));
    expect(edit.details).toMatchObject({ reason: "invalid_transition" });
    expect(ok(run(ports, "artifact.restore", { opId: "01M5ESM1XHCJ7JYJDBC37MREC2", artifact: NEW }))).toMatchObject({ version: 1 });
  });

  it("checks a comment's anchor against the type, then posts it on the artifact's subject", () => {
    const { ports, comments } = memoryPorts();
    ok(run(ports, "artifact.create", { opId: OP, artifactId: NEW, type: "sheet", title: "Budget" }));
    expect(failure(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "hi", anchor: { kind: "text", quote: "x" } })).details)
      .toMatchObject({ path: "anchor" });
    expect(comments).toEqual([]);
    expect(ok(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "hi", anchor: { kind: "cells", range: "B2" } })))
      .toEqual({ disposition: "applied", opId: OP2, threadId: "T1", messageId: "M1", notified: ["S1"] });
    expect(comments[0]).toEqual({
      input: {
        subject: { kind: "artifact", nodeId: "AR", artifactId: NEW },
        anchor: { kind: "cells", range: "B2" },
        text: "hi",
        actor: caller("S1").actor,
        opId: OP2,
      },
      people: ["S1"],
    });
  });

  it("refuses a text anchor whose quote the document does not hold, and names the kinds a wrong anchor could be", () => {
    const { ports, comments } = memoryPorts();
    createDoc(ports, { body: { markdown: "Ship the **tabs** today" } });
    const absent = failure(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "hi", anchor: { kind: "text", quote: "not here" } }));
    expect(absent).toMatchObject({ type: "InputError", message: "the quote is not in this document at version 1", details: { path: "anchor" } });
    expect(absent.details?.next_step).toContain("junto artifact show");
    const cells = failure(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "hi", anchor: { kind: "cells", range: "B2" } }));
    expect(cells.details?.next_step).toBe("anchor it with whole or text, or leave --anchor out to comment on the whole document");
    expect(comments).toEqual([]);
    ok(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "hi", anchor: { kind: "text", quote: "**tabs**" } }));
    expect(comments).toHaveLength(1);
  });

  it("posts a whole-anchored comment with no anchor, and a refusal keeps its opId", () => {
    const { ports, comments } = memoryPorts();
    createDoc(ports);
    ok(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "hi", anchor: { kind: "whole" } }));
    expect(comments[0]?.input).not.toHaveProperty("anchor");
    expect(failure(run(ports, "artifact.comment", { opId: OP2, artifact: NEW, text: "refuse" })).details)
      .toMatchObject({ reason: "not_in_reach", opId: OP2 });
  });

  it("answers a pending body as retryable, pulls it on the seat's reach, and reads it once pulled", () => {
    const { ports, pulls } = memoryPorts();
    createDoc(ports, { body: { markdown: "# far" } });
    // A replica: the head is here, its bytes are not, until the pull keeps them.
    let pulled = false;
    const replica: ArtifactPorts = {
      ...ports,
      head: (canvas, id) => Effect.map(ports.head(canvas, id), Option.map((head) => (pulled ? head : { ...head, body: null }))),
      pull: (input) => Effect.andThen(ports.pull(input), Effect.sync(() => { pulled = true; })),
    };
    expect(failure(run(replica, "artifact.show", { artifact: NEW })).details).toMatchObject({ reason: "not_available", retryable: true });
    expect(pulls).toEqual([
      {
        ref: artifactBodyRef({ type: "document", markdown: "# far" }),
        owner: { kind: "artifact", canvasName: "factory", nodeId: "AR", recordId: `${NEW}@1` },
        reached: { canvasName: "factory", resourceId: "AR" },
      },
    ]);
    expect(ok<ArtifactShowResult>(run(replica, "artifact.show", { artifact: NEW })).text).toBe("# far");
  });

  it("refuses unknown keys and a malformed opId", () => {
    const { ports } = memoryPorts();
    expect(failure(run(ports, "artifact.list", { nodes: "x" }))).toMatchObject({ type: "InputError" });
    expect(failure(run(ports, "artifact.archive", { opId: "op-1", artifact: NEW }))).toMatchObject({ type: "InputError" });
    expect(failure(run(ports, "artifact.show", { artifact: ItemId.make(NEW).toLowerCase() }))).toMatchObject({ type: "InputError" });
  });
});

describe.runIf(!ARTIFACTS_ENABLED)("an artifacts-off build", () => {
  it("refuses every artifact op before it reads one", () => {
    for (const op of ARTIFACT_OPS) {
      const refused = failure(run(memoryPorts().ports, op, {}));
      expect([refused.type, refused.details?.missing, refused.details?.reason], op).toEqual(["ScopeError", "feature enabled in this build", op]);
    }
  });
});

// Plan 0.11, 02, L5: [[Title]] in a seat's create or edit becomes the app's link, by id.
describe.runIf(ARTIFACTS_ENABLED)("[[Title]] in junto artifact create and edit", () => {
  const PLAN = "01M5ESMQ2ZT55QZ073EWPH10SH";
  const PLAN2 = "01M5ESMQ2ZT55QZ073EWPH10SJ";
  const AWAY = "01M5ESMQ2ZT55QZ073EWPH10SK";
  const planLink = (id: string, node = "AR", title = "Launch plan") =>
    artifactLink({ kind: "artifact", nodeId: asNodeId(node), artifactId: ItemId.make(id) }, title, "factory");
  const seed = (ports: ArtifactPorts) => {
    ok(run(ports, "artifact.create", { opId: "01M5ESM1XHCJ7JYJDBC37MRE00", artifactId: PLAN, type: "document", title: "Launch plan" }));
    // Out of S1's reach: never a match, never a candidate.
    ok(run(ports, "artifact.create", { opId: "01M5ESM1XHCJ7JYJDBC37MRE01", artifactId: AWAY, type: "document", title: "Launch plan" }, "SP"));
  };
  const bodyOf = (submitted: ReturnType<typeof memoryPorts>["submitted"]) => {
    const op = submitted.at(-1)!.op;
    return op.op === "create" ? op.body : op.op === "edit" ? op.edit : undefined;
  };

  it("links a title in reach, matched without case, as the app writes it", () => {
    const { ports, submitted } = memoryPorts();
    seed(ports);
    createDoc(ports, { body: { markdown: "see [[launch PLAN]]" } });
    expect(bodyOf(submitted)).toEqual({ type: "document", markdown: `see ${planLink(PLAN)}` });
  });

  it("refuses a title several artifacts carry, naming them, and takes an id in the brackets", () => {
    const { ports, submitted } = memoryPorts();
    seed(ports);
    ok(run(ports, "artifact.create", { opId: "01M5ESM1XHCJ7JYJDBC37MRE02", artifactId: PLAN2, type: "document", title: "Launch Plan" }));
    const before = submitted.length;
    const refused = failure(run(ports, "artifact.create", { opId: OP, artifactId: NEW, type: "document", title: "Notes", body: { markdown: "[[Launch plan]]" } }));
    expect(refused).toMatchObject({ type: "InputError", details: { target: "[[Launch plan]]", opId: OP, next_step: "write [[<artifactId>]] for the one you mean" } });
    expect(refused.details?.candidates?.map((candidate) => candidate.itemId).sort()).toEqual([PLAN, PLAN2]);
    expect(JSON.stringify(refused)).not.toContain(AWAY);
    expect(submitted).toHaveLength(before);
    createDoc(ports, { body: { markdown: `[[${PLAN2}]]` } });
    expect(bodyOf(submitted)).toEqual({ type: "document", markdown: planLink(PLAN2, "AR", "Launch Plan") });
  });

  it("refuses a title nothing in reach carries, with the nearest, and keeps \\[[ as text", () => {
    const { ports, submitted } = memoryPorts();
    seed(ports);
    const refused = failure(run(ports, "artifact.create", { opId: OP, artifactId: NEW, type: "document", title: "Notes", body: { markdown: "[[Lanch plan]]" } }));
    expect(refused).toMatchObject({ type: "UnknownTarget", details: { target: "[[Lanch plan]]", candidates: [{ itemId: PLAN, name: "Launch plan" }] } });
    createDoc(ports, { body: { markdown: "\\[[Lanch plan]]" } });
    expect(bodyOf(submitted)).toEqual({ type: "document", markdown: "\\[[Lanch plan]]" });
  });

  it("show lists the mail and comments that link here, only those this seat may read", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    const subject = (node: string) => ({ threadSubject: { kind: "artifact", nodeId: node, artifactId: "01M5ESMQ2ZT55QZ073EWPH10SH" } });
    const row = (id: string, mailbox: string, sender: string, at: number, extra: Record<string, unknown> = {}) => ({
      node_id: mailbox,
      message_id: id,
      at_ms: at,
      actor_seat_id: `seat_${"b".repeat(64)}`,
      metadata_json: JSON.stringify({ senderNodeId: sender, ...extra }),
    });
    const rows = [
      row("M-own", "S1", "SP", 5),
      row("M-sent", "SP", "S1", 4),
      row("M-private", "SP", "TN", 3),
      row("M-here", "AR", "SP", 2, subject("AR")),
      row("M-away", "AP", "SP", 1, subject("AP")),
      // A subject stamped on a seat's mail, or on a row away from its resource: never a thread.
      row("M-seat", "S2", "TN", 0, subject("S2")),
      row("M-moved", "TN", "SP", 0, subject("AR")),
    ];
    const asked: string[] = [];
    const withMentions: ArtifactPorts = { ...ports, mentions: (_canvas, key) => Effect.sync(() => (asked.push(key), rows)) };
    const shown = ok<ArtifactShowResult>(run(withMentions, "artifact.show", { artifact: NEW }));
    expect(asked).toEqual([mentionKey({ kind: "artifact", nodeId: asNodeId("AR"), artifactId: ItemId.make(NEW) })]);
    expect(shown.linkedFrom.mail.map((entry) => entry.messageId)).toEqual(["M-own", "M-sent", "M-here"]);
    expect(shown.linkedFrom.more).toBe(false);
    expect(ok<ArtifactShowResult>(run(ports, "artifact.show", { artifact: NEW })).linkedFrom).toEqual({ bodies: [], mail: [], more: false });
  });

  it("show lists the artifacts whose body links here, only from nodes in this seat's reach", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    const from = (node: string, id: string, title: string) => ({
      source: { nodeId: asNodeId(node), artifactId: ItemId.make(id) },
      title,
      type: "document" as const,
      line: `see ${title}`,
      at: 1,
    });
    const linking = [from("AR", "01M5ESMQ2ZT55QZ073EWPH10SH", "Plan"), from("AP", "01M5ESMQ2ZT55QZ073EWPH10SK", "Away")];
    const asked: unknown[] = [];
    const withLinks: ArtifactPorts = { ...ports, bodyLinks: (_board, _canvas, target) => Effect.sync(() => (asked.push(target), linking)) };
    const shown = ok<ArtifactShowResult>(run(withLinks, "artifact.show", { artifact: NEW }));
    expect(asked).toEqual([{ nodeId: "AR", artifactId: NEW }]);
    expect(shown.linkedFrom.bodies).toEqual([linking[0]]);
  });

  it("links what a document's patches write, and a sheet's cells on replace", () => {
    const { ports, submitted } = memoryPorts();
    seed(ports);
    createDoc(ports, { body: { markdown: "plan: " } });
    ok(run(ports, "artifact.edit", { opId: OP2, artifact: NEW, baseVersion: 1, patches: [{ op: "splice", at: 6, remove: 0, insert: "[[Launch plan]]" }] }));
    expect(ok(run(ports, "artifact.show", { artifact: NEW }))).toMatchObject({ version: 2, text: `plan: ${planLink(PLAN)}` });

    ok(run(ports, "artifact.create", { opId: "01M5ESM1XHCJ7JYJDBC37MRE03", artifactId: PLAN2, type: "sheet", title: "Budget" }));
    ok(run(ports, "artifact.edit", {
      opId: "01M5ESM1XHCJ7JYJDBC37MRE04",
      artifact: PLAN2,
      baseVersion: 1,
      body: { body: { grid: { columns: [{ id: "c1", name: "A" }], rows: [{ id: "r1", cells: { c1: "[[Launch plan]]" } }] } } },
    }));
    expect(bodyOf(submitted)).toMatchObject({ kind: "replace", body: { grid: { rows: [{ cells: { c1: planLink(PLAN) } }] } } });
  });
});

describe("bodyFor", () => {
  it("reads markdown, a url, or JSON with the type filled in", () => {
    const document = bodyFor("document", { markdown: "# x" }, "body");
    expect(document._tag === "Success" && document.success).toEqual({ type: "document", markdown: "# x" });
    const link = bodyFor("link", { url: "https://example.com" }, "body");
    expect(link._tag === "Success" && link.success).toEqual({ type: "link", target: { kind: "url", url: "https://example.com" } });
    const sheet = bodyFor("sheet", { body: { grid: { columns: [], rows: [] } } }, "body");
    expect(sheet._tag).toBe("Success");
  });

  it("refuses a body of another type", () => {
    expect(bodyFor("sheet", { markdown: "# x" }, "body")._tag).toBe("Failure");
    expect(bodyFor("document", { body: { type: "sheet", grid: { columns: [], rows: [] } } }, "body")._tag).toBe("Failure");
    expect(bodyFor("link", { url: "ftp://example.com" }, "body")._tag).toBe("Failure");
  });
});

describe.runIf(ARTIFACTS_ENABLED)("junto artifact labels in main", () => {
  const OP3 = "01M5ESM1XHCJ7JYJDBC37MREC1";
  const labelsOf = (ports: ArtifactPorts) => ok<ArtifactShowResult>(run(ports, "artifact.show", { artifact: NEW })).artifact.labels;

  it("creates with labels folded, and refuses one that cannot be a label before anything is ruled", () => {
    const { ports, submitted } = memoryPorts();
    createDoc(ports, { labels: [" Project/Junto ", "draft", "DRAFT"] });
    expect(submitted[0]?.op).toMatchObject({ op: "create", labels: ["draft", "project/junto"] });
    expect(labelsOf(ports)).toEqual(["draft", "project/junto"]);

    const bad = memoryPorts();
    const refused = failure(run(bad.ports, "artifact.create", { opId: OP, artifactId: NEW, type: "document", title: "N", labels: ["ok", "a//b"] }));
    expect(refused).toMatchObject({ type: "InputError", details: { path: "labels[1]", received: "a//b" } });
    expect(refused.message).toContain("1 to 40 characters");
    expect(bad.submitted).toEqual([]);
  });

  it("sets the whole set, adds and removes against the head, and never moves the version", () => {
    const { ports, submitted } = memoryPorts();
    createDoc(ports, { labels: ["draft"] });
    expect(ok(run(ports, "artifact.label", { opId: OP2, artifact: NEW, add: ["Shipped", "project/junto"], remove: ["draft"] })))
      .toEqual({ disposition: "applied", opId: OP2, artifactId: NEW, version: 1 });
    expect(submitted[1]?.op).toEqual({ op: "labels", labels: ["project/junto", "shipped"] });
    expect(labelsOf(ports)).toEqual(["project/junto", "shipped"]);
    // Removing one it does not hold changes nothing.
    ok(run(ports, "artifact.label", { opId: OP3, artifact: NEW, remove: ["absent"] }));
    expect(labelsOf(ports)).toEqual(["project/junto", "shipped"]);
    ok(run(ports, "artifact.label", { opId: "01M5ESM1XHCJ7JYJDBC37MREC2", artifact: NEW, set: [] }));
    expect(labelsOf(ports)).toEqual([]);
    expect(ok<ArtifactShowResult>(run(ports, "artifact.show", { artifact: NEW })).version).toBe(1);
  });

  it("wants --set or --add/--remove, refuses a 21st label with the opId, and reads one out of reach as unknown", () => {
    const { ports } = memoryPorts();
    createDoc(ports);
    expect(failure(run(ports, "artifact.label", { opId: OP2, artifact: NEW }))).toMatchObject({ type: "InputError", details: { path: "set", opId: OP2 } });
    expect(failure(run(ports, "artifact.label", { opId: OP2, artifact: NEW, set: ["a"], add: ["b"] }))).toMatchObject({ type: "InputError" });
    const twenty = Array.from({ length: 20 }, (_, index) => `l${index}`);
    ok(run(ports, "artifact.label", { opId: OP2, artifact: NEW, set: twenty }));
    expect(failure(run(ports, "artifact.label", { opId: OP3, artifact: NEW, add: ["one-more"] }))).toMatchObject({
      type: "InputError",
      message: "an artifact holds at most 20 labels",
      details: { opId: OP3 },
    });
    expect(failure(run(ports, "artifact.label", { opId: OP3, artifact: NEW, add: ["x"] }, "SP"))).toMatchObject({ type: "UnknownTarget" });
  });

  it("adds on top of this machine's own labels write still queued for the editing machine, not the ruled head", () => {
    const { ports, submitted } = memoryPorts();
    createDoc(ports, { labels: ["draft"] });
    // `--add a` went out and is queued, unruled: the head here still reads [draft].
    const queued: ArtifactPorts = { ...ports, queuedLabels: (_canvas, id) => Effect.succeed(id === NEW ? Option.some(["a", "draft"]) : Option.none()) };
    ok(run(queued, "artifact.label", { opId: OP2, artifact: NEW, add: ["b"] }));
    expect(submitted[1]?.op).toEqual({ op: "labels", labels: ["a", "b", "draft"] });
    ok(run(queued, "artifact.label", { opId: OP3, artifact: NEW, add: ["c"], remove: ["c"] }));
    expect(submitted[2]?.op).toEqual({ op: "labels", labels: ["a", "draft"] });
  });

  it("lists each artifact's labels and filters by every label named, a level matching those under it", () => {
    const { ports, submitted } = memoryPorts();
    createDoc(ports, { labels: ["project/junto/release", "draft"] });
    ok(run(ports, "artifact.create", { opId: OP2, artifactId: "01M5ESMQ2ZT55QZ073EWPH10SH", type: "sheet", title: "Budget", labels: ["project/junto"] }));
    const ids = (labels: ReadonlyArray<string>) =>
      ok<{ artifacts: ReadonlyArray<{ artifactId: string; labels: ReadonlyArray<string> }> }>(run(ports, "artifact.list", { labels })).artifacts.map((a) => a.artifactId).sort();
    expect(ids(["Project/Junto"])).toEqual([NEW, "01M5ESMQ2ZT55QZ073EWPH10SH"].sort());
    expect(ids(["project/junto", "draft"])).toEqual([NEW]);
    expect(ids(["project/jun"])).toEqual([]);
    const rows = ok<{ artifacts: ReadonlyArray<{ artifactId: string; labels: ReadonlyArray<string> }> }>(run(ports, "artifact.list", {})).artifacts;
    expect(rows.find((row) => row.artifactId === NEW)?.labels).toEqual(["draft", "project/junto/release"]);
    expect(failure(run(ports, "artifact.list", { labels: [""] }))).toMatchObject({ details: { path: "labels[0]" } });
    expect(failure(run(ports, "artifact.list", { labels: ["/bad"] }))).toMatchObject({ details: { path: "labels[0]" } });
    expect(submitted).toHaveLength(2);
  });
});
