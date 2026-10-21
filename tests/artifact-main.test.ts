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
        .filter((a) => query.nodeIds.includes(a.nodeId) && a.archived === query.archived && (query.type === undefined || a.type === query.type));
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
