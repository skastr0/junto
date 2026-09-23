import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import type { Port } from "../src/shared/physics";
import { buildInjectionText } from "../src/shared/managed-terminal-injection";
import { decodeManagedSpawnIntent } from "../src/shared/term-control";
import {
  connectedTargetsForNode,
  makeManagedSpawnIntent,
} from "../src/main/junto/term/managed-spawn-plan";

const agent = (id: string, host = "local"): CanvasNode => ({
  id, type: "text", text: id, x: 0, y: 0, width: 200, height: 100,
  ether: {
    entity: { kind: "agent", name: `${host}:${id}` },
    host,
    terminal: {
      bindingId: `binding-${id}`,
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
    },
  },
});

const peerEdge = (
  verb: "messages" | "reviews",
  fromNode = "worker",
  toNode = "peer",
  mask?: readonly Port[],
): CanvasEdge => ({
  id: `${verb}-${fromNode}-${toNode}`,
  fromNode,
  toNode,
  ether: { verb, ...(mask === undefined ? {} : { mask }) },
});

const peers = (edges: readonly CanvasEdge[], nodes = [agent("worker"), agent("peer")]): CanvasDoc => ({
  nodes, edges,
});

const compile = (doc: CanvasDoc, nodeId = "worker") => {
  const targets = connectedTargetsForNode(doc, nodeId);
  const intent = makeManagedSpawnIntent({ doc, nodeId, harness: "claude" });
  expect(intent.injection.connectedTargets).toEqual(targets);
  const text = buildInjectionText(intent.injection);
  if (text === null) throw new Error("A canvas-bound seat must receive doctrine");
  // Inspect executable examples separately from prose explaining refused powers.
  const commands = [...text.matchAll(/`(junto [^`]+)`/g)].map((match) => match[1]!);
  return { targets, intent, text, commands };
};

const targetPorts = (compiled: ReturnType<typeof compile>, id: string) => {
  const target = compiled.targets.find((candidate) => candidate.id === id);
  if (target === undefined) throw new Error(`Missing connected target ${id}`);
  return [...(target.ports ?? [])].sort();
};

const hasCommand = (commands: readonly string[], prefix: string): boolean =>
  commands.some((command) => command.startsWith(`junto ${prefix}`));

describe("crew doctrine compiled from authored grants", () => {
  it("teaches review only to the drawn reviewer, without inventing peer mail or task access", () => {
    const doc = peers([peerEdge("reviews")]);
    const reviewer = compile(doc);
    expect(targetPorts(reviewer, "peer")).toEqual(["verdict.post"]);
    expect(reviewer.intent.injection.connected).toBe(true);
    expect(reviewer.text).toContain("### Edge contract — reviews (authors: `peer`)");
    expect(hasCommand(reviewer.commands, "verdict post ")).toBe(true);
    for (const prefix of ["msg send ", "msg prompt ", "seat wait ", "seat read ", "tasks show "]) {
      expect(hasCommand(reviewer.commands, prefix), prefix).toBe(false);
    }
    expect(reviewer.commands).toContain("junto msg list");
    expect(reviewer.text).toContain("receipt's target board, task id, epoch and subjectHash exactly");
    expect(reviewer.text).toContain("`tasks show` is available only with a separate task-list grant");
    expect(reviewer.text).toContain("never rebinding your old verdict to newer work");

    const author = compile(doc, "peer");
    expect(targetPorts(author, "worker")).toEqual([]);
    expect(author.intent.injection.connected).toBe(false);
    expect(author.text).not.toContain("### Edge contract —");
    expect(hasCommand(author.commands, "verdict post ")).toBe(false);
  });

  it.each(["worker", "peer"])("activates peer-only messages doctrine for %s", (caller) => {
    const target = caller === "worker" ? "peer" : "worker";
    const compiled = compile(peers([peerEdge("messages")]), caller);
    expect(targetPorts(compiled, target)).toEqual([
      "msg.list", "msg.prompt", "msg.send", "seat.wait", "terminal.read",
    ]);
    expect(compiled.intent.injection.connected).toBe(true);
    expect(compiled.commands).toContain(`junto msg send '{"target":"${target}","text":"..."}'`);
    expect(compiled.commands).toContain(`junto msg prompt '{"target":"${target}","text":"..."}'`);
    expect(compiled.commands).toContain(`junto seat wait ${target} --until idle --timeout 30s`);
    expect(compiled.commands).toContain(`junto seat read ${target} --lines 40`);
    expect(hasCommand(compiled.commands, "verdict post ")).toBe(false);
  });

  it.each([
    { port: "msg.prompt", command: "msg prompt ", absent: ["msg send ", "msg reply ", "seat wait ", "seat read "] },
    { port: "terminal.read", command: "seat read ", absent: ["msg send ", "msg reply ", "msg prompt ", "seat wait "] },
  ] as const)("teaches only $port under an attenuated messages edge", ({ port, command, absent }) => {
    const compiled = compile(peers([peerEdge("messages", "worker", "peer", [port])]));
    expect(targetPorts(compiled, "peer")).toEqual([port]);
    expect(compiled.intent.injection.connected).toBe(true);
    expect(hasCommand(compiled.commands, command)).toBe(true);
    for (const prefix of absent) expect(hasCommand(compiled.commands, prefix), prefix).toBe(false);
    expect(compiled.commands).not.toContain('junto msg list \'{"target":"peer"}\'');
    expect(hasCommand(compiled.commands, "verdict post ")).toBe(false);
  });

  it.each(["messages", "reviews"] as const)("an empty %s mask leaves only base doctrine", (verb) => {
    const compiled = compile(peers([peerEdge(verb, "worker", "peer", [])]));
    expect(targetPorts(compiled, "peer")).toEqual([]);
    expect(compiled.intent.injection.connected).toBe(false);
    expect(compiled.text).not.toContain("### Edge contract —");
    expect(compiled.commands).toContain("junto onboard");
  });

  it("uses the eligible peer for each command when neighboring grants differ", () => {
    const compiled = compile(peers([
      peerEdge("messages", "worker", "a-waiter", ["seat.wait"]),
      peerEdge("messages", "worker", "b-sender", ["msg.send"]),
      peerEdge("messages", "worker", "c-reader", ["terminal.read"]),
    ], [agent("worker"), agent("a-waiter"), agent("b-sender"), agent("c-reader")]));
    expect(compiled.commands.filter((command) => command.startsWith("junto msg send "))).toEqual([
      'junto msg send \'{"target":"b-sender","text":"..."}\'',
    ]);
    expect(compiled.commands.filter((command) => command.startsWith("junto seat wait "))).toEqual([
      "junto seat wait a-waiter --until idle --timeout 30s",
    ]);
    expect(compiled.commands.filter((command) => command.startsWith("junto seat read "))).toEqual([
      "junto seat read c-reader --lines 40",
    ]);
    expect(hasCommand(compiled.commands, "msg prompt ")).toBe(false);
  });

  it("unions parallel review and wait grants without reversing review authority", () => {
    const doc = peers([
      peerEdge("reviews"),
      peerEdge("messages", "worker", "peer", ["seat.wait"]),
    ]);
    const reviewer = compile(doc);
    expect(reviewer.targets).toHaveLength(1);
    expect(targetPorts(reviewer, "peer")).toEqual(["seat.wait", "verdict.post"]);
    expect(hasCommand(reviewer.commands, "verdict post ")).toBe(true);
    expect(reviewer.commands).toContain("junto seat wait peer --until idle --timeout 30s");
    expect(hasCommand(reviewer.commands, "msg send ")).toBe(false);

    const author = compile(doc, "peer");
    expect(targetPorts(author, "worker")).toEqual(["seat.wait"]);
    expect(author.commands).toContain("junto seat wait worker --until idle --timeout 30s");
    expect(hasCommand(author.commands, "verdict post ")).toBe(false);
  });

  it("stages real commit evidence while working and binds review to the exact current subject", () => {
    const doc: CanvasDoc = {
      nodes: [agent("worker"), {
        id: "tasks", type: "text", text: "Tasks", x: 250, y: 0, width: 200, height: 100,
        ether: {
          entity: { kind: "task" },
          tasks: { items: [], contract: { rules: [{ id: "review", text: "Independent review", kind: "requires-review" }] } },
        },
      }],
      edges: [{ id: "works", fromNode: "tasks", toNode: "worker", ether: { verb: "works" } }],
    };
    const compiled = compile(doc);
    const prefix = "junto tasks update '";
    const stage = compiled.commands.find((command) => command.startsWith(prefix) && command.includes('"completionEvidence"'));
    if (stage === undefined) throw new Error("Missing staged evidence command");
    expect(JSON.parse(stage.slice(prefix.length, -1))).toEqual({
      target: "tasks", task: "<taskId>", state: "working",
      completionEvidence: { artifacts: [], git: { commits: ["<real-sha>"] } },
    });
    expect(compiled.text).toContain("stages evidence without completing the task");
    expect(compiled.text).toContain("current epoch and subjectHash");
    expect(compiled.text).toContain("changed ref or epoch invalidates prior approval");
    expect(compiled.text).toContain("complete with the same evidence");
    expect(compiled.text).toContain("Requires-review completion is Command Center only");

    const readOnly = compile({
      ...doc,
      edges: [{ ...doc.edges[0]!, ether: { verb: "works", mask: ["tasks.list"] } }],
    });
    expect(hasCommand(readOnly.commands, "tasks show ")).toBe(true);
    expect(hasCommand(readOnly.commands, "tasks update ")).toBe(false);
    expect(readOnly.text).not.toContain("### Stage evidence before review");
  });

  it.each(["worker", "peer"])("states Remote prerequisites while preserving durable mail when %s is remote", (remoteId) => {
    const compiled = compile(peers([peerEdge("messages")], [
      agent("worker", remoteId === "worker" ? "studio" : "local"),
      agent("peer", remoteId === "peer" ? "studio" : "local"),
    ]));
    expect(compiled.commands).toContain('junto msg send \'{"target":"peer","text":"..."}\'');
    // This pins the advertised prerequisites, not a live Remote execution proof.
    expect(compiled.text).toContain("Crew prompt, sent receipts, seat wait and seat read require a configured Command Center");
    expect(compiled.text).toContain("Prompt/wait/read require a local peer, and are unavailable for Remote seats");
    expect(compiled.text).toContain("Ordinary durable mail remains available through its own grants");
    expect(compiled.text).toContain("delivered to a local peer whether it is idle or mid-turn; its harness queues or steers it");
  });

  it("retains compiled ports across the host-finalized spawn wire and refuses unknown ports", () => {
    const compiled = compile(peers([
      peerEdge("reviews"),
      peerEdge("messages", "worker", "peer", ["seat.wait"]),
    ]));
    const decoded = decodeManagedSpawnIntent(JSON.parse(JSON.stringify(compiled.intent)));
    expect(decoded).toEqual(compiled.intent);
    if (decoded === undefined) throw new Error("Compiled spawn intent did not decode");
    expect(decoded.injection.connectedTargets?.[0]?.ports).toEqual(compiled.targets[0]?.ports);
    expect(buildInjectionText(decoded.injection)).toBe(compiled.text);

    expect(decodeManagedSpawnIntent({
      ...compiled.intent,
      injection: {
        ...compiled.intent.injection,
        connectedTargets: compiled.targets.map((target) => ({
          ...target, ports: [...(target.ports ?? []), "terminal.write"],
        })),
      },
    })).toBeUndefined();
  });
});
