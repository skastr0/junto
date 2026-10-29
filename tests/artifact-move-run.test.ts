import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { emptyBody, type ArtifactOp } from "../src/shared/artifact";
import { artifactDomain, emptyArtifactState, type ArtifactFact, type ArtifactState } from "../src/shared/artifact-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import { emptyRuled, mintItemId, mintOpId, rule, type ItemId, type ResourceActor, type ResourceCommand, type Ruled } from "../src/shared/resource-command";
import { localBodyRef } from "../src/renderer/lib/artifacts-source";
import { moveArtifacts, type ArtifactMovePorts } from "../src/main/junto/work/artifact-move";
import { artifacts, canvasOf, region, seat } from "./support/model-nodes";

const domain = artifactDomain({ now: () => 5_000, bodyRef: localBodyRef });
const mini = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };

// Specs and Release sit in two sibling regions; a seat in Specs reaches only Specs.
const canvas = canvasOf([
  region("product", { x: 0, y: 0, width: 400, height: 400 }),
  region("ship", { x: 1000, y: 0, width: 400, height: 400 }),
  artifacts("specs", { x: 10, y: 10, width: 100, height: 100 }),
  artifacts("release", { x: 1010, y: 10, width: 100, height: 100 }),
  seat("writer", { x: 200, y: 10, width: 100, height: 100 }),
  seat("lead", { x: 1200, y: 10, width: 50, height: 50 }),
]);
const specs = asNodeId("specs");
const release = asNodeId("release");

/** Ports over one in-memory ruler, as main's submit rules. */
const portsOf = (seed: ReadonlyArray<{ id: ItemId; title: string }>) => {
  let ruled: Ruled<ArtifactState, ArtifactFact> = emptyRuled(emptyArtifactState());
  const submitted: Array<ResourceCommand<ArtifactOp>> = [];
  for (const { id, title } of seed) {
    ruled = rule(domain, ruled, mini, { opId: mintOpId(), canvasName: "factory", actor: operator, target: { kind: "artifact", nodeId: specs, itemId: id }, basis: null, after: [], op: { op: "create", title, body: emptyBody("document") } }, { inReach: () => true }).ruled;
  }
  const ports = {
    topology: () => Effect.succeed(canvas),
    artifacts: {
      head: (_canvasName: string, id: ItemId) => {
        const entry = ruled.state.get(id);
        return Effect.succeed(entry === undefined ? Option.none() : Option.some({ artifact: entry.artifact, body: entry.body, bodyRef: entry.bodyRef }));
      },
      submit: (command: ResourceCommand<ArtifactOp>, context: { readonly inReach: (actor: ResourceActor, target: never) => boolean }) => {
        submitted.push(command);
        // As the repository rules a move: it must reach where it goes too.
        const op = command.op;
        const reach = { inReach: (actor: ResourceActor, target: never) => context.inReach(actor, target) && (op.op !== "move" || context.inReach(actor, { ...(target as object), nodeId: op.to } as never)) };
        const next = rule(domain, ruled, mini, command, reach as never);
        ruled = next.ruled;
        return Effect.succeed(next.ruling.kind === "applied" ? { kind: "applied", opId: command.opId, facts: next.ruling.facts } : { kind: "refused", opId: command.opId, error: next.ruling.error, root: next.ruling.root });
      },
    },
  } as unknown as ArtifactMovePorts;
  return { ports, submitted, nodeOf: (id: ItemId) => ruled.state.get(id)?.artifact.nodeId };
};

const run = (ports: ArtifactMovePorts, artifactIds: ReadonlyArray<ItemId>, toNode = release, by: ResourceActor = operator) =>
  Effect.runPromise(moveArtifacts(ports, { canvasName: "factory", artifactIds, toNode }, by));

describe("runArtifactMove", () => {
  it("moves each artifact, answers a row each in the order asked, and counts them", async () => {
    const plan = mintItemId();
    const notes = mintItemId();
    const gone = mintItemId();
    const { ports, nodeOf } = portsOf([{ id: plan, title: "Plan" }, { id: notes, title: "Notes" }]);
    const answer = await run(ports, [notes, gone, plan]);
    expect(answer).toEqual({
      ok: true,
      moved: 2,
      refused: 1,
      results: [
        { artifactId: notes, title: "Notes", ok: true, outcome: "moved", from: specs, to: release },
        { artifactId: gone, ok: false, code: "not-found", reason: "Junto could not find that artifact on this canvas." },
        { artifactId: plan, title: "Plan", ok: true, outcome: "moved", from: specs, to: release },
      ],
    });
    expect(nodeOf(plan)).toBe(release);
  });

  it("a retried move is unchanged, not refused, and sends nothing", async () => {
    const plan = mintItemId();
    const { ports, submitted } = portsOf([{ id: plan, title: "Plan" }]);
    await run(ports, [plan]);
    const again = await run(ports, [plan]);
    expect(again).toMatchObject({ ok: true, moved: 0, refused: 0, results: [{ outcome: "unchanged", from: release, to: release }] });
    expect(submitted).toHaveLength(1);
  });

  it("refuses the whole call for a target that is not an Artifacts node, or a list that is empty, too long or repeats", async () => {
    const plan = mintItemId();
    const { ports, submitted } = portsOf([{ id: plan, title: "Plan" }]);
    expect(await run(ports, [plan], asNodeId("nowhere"))).toMatchObject({ ok: false, code: "not_found" });
    expect(await run(ports, [plan], asNodeId("writer"))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await run(ports, [])).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await run(ports, [plan, plan])).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await run(ports, Array.from({ length: 101 }, () => mintItemId()))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(submitted).toEqual([]);
  });

  it("a seat moves only where it reaches, from and to", async () => {
    const plan = mintItemId();
    const { ports, nodeOf } = portsOf([{ id: plan, title: "Plan" }]);
    const writer: ResourceActor = { kind: "seat", seatId: `seat_${"a".padEnd(64, "0")}` as never, nodeId: asNodeId("writer") };
    const answer = await run(ports, [plan], release, writer);
    expect(answer).toMatchObject({ ok: true, moved: 0, refused: 1, results: [{ artifactId: plan, title: "Plan", ok: false, code: "not-in-reach" }] });
    expect(nodeOf(plan)).toBe(specs);
  });

  it("an artifact the mover does not reach is not found, its title unsaid", async () => {
    const plan = mintItemId();
    const { ports, nodeOf } = portsOf([{ id: plan, title: "Plan" }]);
    expect(await run(ports, [plan], release)).toMatchObject({ ok: true, moved: 1 });
    const writer: ResourceActor = { kind: "seat", seatId: `seat_${"a".padEnd(64, "0")}` as never, nodeId: asNodeId("writer") };
    const answer = await run(ports, [plan], specs, writer);
    expect(answer).toEqual({
      ok: true,
      moved: 0,
      refused: 1,
      results: [{ artifactId: plan, ok: false, code: "not-found", reason: "Junto could not find that artifact on this canvas." }],
    });
    expect(nodeOf(plan)).toBe(release);
  });
});
