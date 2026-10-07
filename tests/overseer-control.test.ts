import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  OVERSEER_CATALOG,
  OVERSEER_MAX_CORRELATION_BYTES,
  OVERSEER_MAX_REQUEST_BYTES,
  OVERSEER_MAX_BATCH_OPERATIONS,
  OVERSEER_MAX_RESULT_BYTES,
  OVERSEER_OPERATION_NAMES,
  OVERSEER_RETIRED_OPERATIONS,
  OverseerArgsSchemas,
  decodeOverseerArgs,
  decodeOverseerCaller,
  decodeOverseerRequest,
  decodeOverseerResult,
} from "../src/shared/overseer-control";
import { NODE_KINDS } from "../src/shared/model/kinds";
import {
  WORK_MAX_FRAME_BYTES,
  WORK_PROTOCOL_VERSION,
  encodeWorkFrame,
} from "../src/shared/work-control";
import {
  STATION_CONTROL_PROTOCOL,
} from "../src/shared/station-api-envelope";
import {
  STATION_API_PROTOCOL,
} from "../src/shared/station-api";
import {
  STATION_SESSION_PROTOCOL,
} from "../src/shared/station-session";
import {
  STATION_CONTROL_MAX_FRAME_BYTES,
  encodeStationControlFrame,
} from "../src/shared/station-ssh-control";

const succeeds = (result: Result.Result<unknown, unknown>): void => {
  expect(Result.isSuccess(result)).toBe(true);
};

const fails = (result: Result.Result<unknown, unknown>): void => {
  expect(Result.isFailure(result)).toBe(true);
};

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const maximumResult = () => {
  const empty = {
    ok: true as const,
    operation: "content.materialize" as const,
    data: "",
  };
  return {
    ...empty,
    data: "x".repeat(OVERSEER_MAX_RESULT_BYTES - jsonBytes(empty)),
  };
};

describe("overseer command contract", () => {
  it("has one strict args schema and one catalog row for every frozen operation", () => {
    expect(new Set(OVERSEER_OPERATION_NAMES).size).toBe(
      OVERSEER_OPERATION_NAMES.length,
    );
    expect(Object.keys(OverseerArgsSchemas)).toEqual(OVERSEER_OPERATION_NAMES);
    expect(OVERSEER_CATALOG.map(({ operation }) => operation)).toEqual(
      OVERSEER_OPERATION_NAMES,
    );
  });

  it("keeps the outer envelope small and rejects aliases or excess fields", () => {
    succeeds(decodeOverseerRequest({ operation: "canvas.list" }));
    succeeds(
      decodeOverseerRequest({
        operation: "node.get",
        args: { nodeId: "node-1" },
      }),
    );
    fails(decodeOverseerRequest({ operation: "canvas.ls" }));
    fails(
      decodeOverseerRequest({
        operation: "canvas.list",
        args: {},
        caller: { canvasName: "work", nodeId: "agent-1" },
      }),
    );
  });

  const note = { kind: "note", text: "new note", x: 12, y: 24, width: 240, height: 120 };
  // A seat is drafted by naming what it runs; the harness is the only required choice.
  const seat = { kind: "agent", harness: "claude", x: 0, y: 0, width: 240, height: 120 };

  it("accepts only bounded single-canvas structural batches", () => {
    const move = { operation: "node.move", nodeId: "n1", x: 10, y: 20 };
    succeeds(decodeOverseerArgs("canvas.batch", { canvas: "work", expectedSeq: 42, steps: [move] }));
    succeeds(decodeOverseerArgs("canvas.batch", {
      steps: [
        { operation: "node.create", node: { ...note, id: "n9" } },
        { operation: "node.configure", nodeId: "n9", change: { kind: "note", text: "changed" } },
        { operation: "node.resize", nodeId: "n9", width: 300, height: 200 },
        { operation: "node.recolor", nodeIds: ["n9", "n1"], color: null },
        { operation: "wire.connect", wire: { from: "n1", to: "n9" } },
        { operation: "wire.configure", wireId: "w1", change: { verb: "messages", mask: null } },
        { operation: "wire.disconnect", wireId: "w1" },
      ],
    }));
    fails(decodeOverseerArgs("canvas.batch", { steps: [] }));
    fails(decodeOverseerArgs("canvas.batch", {
      steps: Array.from({ length: OVERSEER_MAX_BATCH_OPERATIONS + 1 }, () => move),
    }));
    // The counter is one name and a number: seq out, expectedSeq in.
    fails(decodeOverseerArgs("canvas.batch", { expectedSeq: "42", steps: [move] }));
    fails(decodeOverseerArgs("canvas.batch", { expectedSeq: -1, steps: [move] }));
    fails(decodeOverseerArgs("canvas.batch", { expectedSeq: 1.5, steps: [move] }));
    fails(decodeOverseerArgs("canvas.batch", { expectedRevision: "42", steps: [move] }));
    fails(decodeOverseerArgs("canvas.batch", { operations: [move] }));
    for (const step of [
      { ...move, canvas: "other" },
      { operation: "node.delete", nodeIds: ["n1"] },
      { operation: "canvas.batch", steps: [move] },
      { operation: "agent.start", nodeId: "n1" },
      { operation: "agent.reseat", nodeId: "n1", agentKey: "local:amp", harness: "amp", host: "local" },
      { operation: "edge.connect", wire: { from: "a", to: "b" } },
      { operation: "node.configure", nodeId: "n1", change: { kind: "agent", overseer: true } },
      { operation: "node.configure", nodeId: "n1", change: { kind: "note", apiKey: "secret" } },
    ]) {
      fails(decodeOverseerArgs("canvas.batch", { steps: [step] }));
    }
  });

  it("takes a node told by its kind, with id optional and no z", () => {
    succeeds(decodeOverseerArgs("node.create", { node: note }));
    succeeds(decodeOverseerArgs("node.create", { canvas: "work", node: { ...note, id: "n1", color: "4" } }));
    succeeds(decodeOverseerArgs("node.create", { node: seat }));
    succeeds(decodeOverseerArgs("node.create", {
      node: {
        ...seat, id: "s1", color: "2", label: "Reviewer", host: "local", profile: "work", model: "opus",
        effort: "high", mode: "plan", permissionMode: "acceptEdits", cwd: "~/Projects/junto", onRemove: "kill-session",
      },
    }));
    // A plain terminal is the kind drafted with a command.
    succeeds(decodeOverseerArgs("node.create", {
      node: { kind: "terminal", host: "local", onRemove: "detach", launch: { kind: "command", argv: ["htop"] }, x: 0, y: 0, width: 400, height: 300 },
    }));
    succeeds(decodeOverseerArgs("node.create", {
      node: { kind: "region", label: "CLI", hold: false, x: 0, y: 0, width: 800, height: 600 },
    }));
    for (const node of [
      { ...note, arbitrary: true },
      // Main decides where a new node stacks.
      { ...note, z: 3 },
      { ...note, kind: "sticky" },
      { ...note, width: 0 },
      // No document node is tolerated.
      { type: "text", text: "new note", x: 12, y: 24, width: 240, height: 120 },
      { ...note, ether: { entity: { kind: "agent" } } },
    ]) {
      fails(decodeOverseerArgs("node.create", { node }));
    }
    // Every model kind has a draft, and only those.
    const document = JSON.stringify(Schema.toJsonSchemaDocument(OverseerArgsSchemas["node.create"]));
    for (const kind of NODE_KINDS) expect(document).toContain(`"${kind}"`);
    expect(document).not.toContain("ether");
  });

  it("makes the overseer grant and a seat's identity unrepresentable in a draft or a change", () => {
    // What main works out for a seat is never sent: no command line, no identity, no grant.
    for (const extra of [
      { overseer: true },
      { overseer: false },
      { agentKey: "local:claude" },
      { bindingId: "bind-1" },
      { sessionId: "s" },
      { launch: { kind: "harness", argv: ["claude"] } },
      { z: 1 },
    ]) {
      fails(decodeOverseerArgs("node.create", { node: { ...seat, ...extra } }));
    }
    fails(decodeOverseerArgs("node.create", { node: { kind: "agent", x: 0, y: 0, width: 240, height: 120 } }));
    fails(decodeOverseerArgs("node.create", { node: { ...seat, harness: "not-a-harness" } }));
    fails(decodeOverseerArgs("node.create", { node: { ...seat, model: "" } }));
    succeeds(decodeOverseerArgs("node.configure", {
      nodeId: "agent-2",
      change: { kind: "agent", label: "Renamed", launch: null },
    }));
    for (const change of [
      { kind: "agent", overseer: true },
      { kind: "agent", agentKey: "local:hijack" },
      { kind: "agent", bindingId: "bind-other" },
      { kind: "agent", sessionId: "s" },
      // Color has its own command; position and size theirs.
      { kind: "note", color: "4" },
      { kind: "note", x: 1 },
      // A change says which kind it is for.
      { text: "no kind" },
      { kind: "note", text: null },
    ]) {
      fails(decodeOverseerArgs("node.configure", { nodeId: "agent-2", change }));
    }
    // The old shape is not accepted beside the new one.
    fails(decodeOverseerArgs("node.configure", { nodeId: "agent-2", changes: { text: "old" } }));
    fails(decodeOverseerArgs("node.configure", { nodeId: "agent-2", change: { kind: "note", text: "x" }, changes: {} }));
  });

  it("recolors and deletes by nodeIds, one or many", () => {
    succeeds(decodeOverseerArgs("node.recolor", { nodeIds: ["n1", "n2"], color: "4" }));
    succeeds(decodeOverseerArgs("node.recolor", { canvas: "work", nodeIds: ["n1"], color: null }));
    succeeds(decodeOverseerArgs("node.delete", { nodeIds: ["n1"] }));
    succeeds(decodeOverseerArgs("node.delete", { canvas: "work", nodeIds: ["n1", "n2"] }));
    fails(decodeOverseerArgs("node.recolor", { nodeIds: ["n1"] }));
    fails(decodeOverseerArgs("node.recolor", { nodeIds: [], color: "4" }));
    fails(decodeOverseerArgs("node.recolor", { nodeId: "n1", color: "4" }));
    fails(decodeOverseerArgs("node.delete", { nodeIds: [] }));
    fails(decodeOverseerArgs("node.delete", { nodeId: "n1" }));
  });

  it("takes a wire by from, to and verb, and nothing of an edge", () => {
    succeeds(decodeOverseerArgs("wire.connect", { wire: { from: "a", to: "b" } }));
    succeeds(decodeOverseerArgs("wire.connect", {
      canvas: "work",
      wire: { id: "w1", from: "a", to: "b", verb: "messages", mask: ["msg.prompt"], fromSide: "right", toSide: "left" },
    }));
    for (const wire of [
      { from: "a", to: "b", verb: "arbitrary" },
      { from: "a", to: "a" },
      { fromNode: "a", toNode: "b", verb: "messages" },
      { from: "a", to: "b", label: "old", color: "1" },
      { from: "a", to: "b", fromEnd: "arrow" },
    ]) {
      fails(decodeOverseerArgs("wire.connect", { wire }));
    }
    fails(decodeOverseerArgs("wire.connect", { edge: { from: "a", to: "b" } }));
    succeeds(decodeOverseerArgs("wire.configure", { wireId: "w1", change: { verb: "reviews", mask: null, toSide: null } }));
    fails(decodeOverseerArgs("wire.configure", { wireId: "w1", change: { from: "c" } }));
    fails(decodeOverseerArgs("wire.configure", { wireId: "w1", change: { verb: null } }));
    fails(decodeOverseerArgs("wire.configure", { edgeId: "w1", changes: {} }));
    succeeds(decodeOverseerArgs("wire.get", { wireId: "w1" }));
    succeeds(decodeOverseerArgs("wire.disconnect", { wireId: "w1" }));
    fails(decodeOverseerArgs("wire.disconnect", { edgeId: "w1" }));
    succeeds(decodeOverseerArgs("wire.verbs", { from: "a", to: "b" }));
    fails(decodeOverseerArgs("wire.verbs", { fromNode: "a", toNode: "b" }));
  });

  it("has no edge operation: the six names are retired, each with the wire name that replaced it", () => {
    expect(OVERSEER_OPERATION_NAMES.filter((name) => name.startsWith("edge."))).toEqual([]);
    expect(OVERSEER_CATALOG.some(({ family }) => family === "edge")).toBe(false);
    expect(OVERSEER_RETIRED_OPERATIONS).toEqual({
      "edge.list": "wire.list",
      "edge.get": "wire.get",
      "edge.verbs": "wire.verbs",
      "edge.connect": "wire.connect",
      "edge.configure": "wire.configure",
      "edge.disconnect": "wire.disconnect",
    });
    for (const [retired, replacement] of Object.entries(OVERSEER_RETIRED_OPERATIONS)) {
      fails(decodeOverseerRequest({ operation: retired, args: {} }));
      expect(OVERSEER_OPERATION_NAMES).toContain(replacement);
    }
  });

  it("validates operation semantics rather than only object shape", () => {
    // A reseat names what the seat now runs: the harness and its choices, never a command line.
    fails(decodeOverseerArgs("agent.reseat", { nodeId: "agent-2" }));
    succeeds(decodeOverseerArgs("agent.reseat", { nodeId: "agent-2", harness: "codex" }));
    succeeds(decodeOverseerArgs("agent.reseat", {
      canvas: "work", nodeId: "agent-2", harness: "codex", host: "local", profile: "work",
      model: "gpt-5", effort: "high", mode: "plan", permissionMode: "acceptEdits",
    }));
    for (const extra of [
      { agentKey: "local:codex" },
      { launch: { kind: "harness", argv: ["codex"] } },
      { launch: null },
      { cwd: "~/elsewhere" },
      { bindingId: "bind-mine" },
      { sessionId: "s" },
      { overseer: true },
      { label: "Renamed" },
      { model: "" },
    ]) {
      fails(decodeOverseerArgs("agent.reseat", { nodeId: "agent-2", harness: "codex", ...extra }));
    }
    fails(decodeOverseerArgs("agent.reseat", { nodeId: "agent-2", harness: "not-a-harness" }));
    // A scheduler change is the cron or the watcher edit, no other kind.
    succeeds(decodeOverseerArgs("scheduler.configure", { nodeId: "c1", change: { kind: "cron", expression: "0 9 * * 1-5" } }));
    succeeds(decodeOverseerArgs("scheduler.configure", { nodeId: "c1", change: { kind: "cron", expression: null } }));
    succeeds(decodeOverseerArgs("scheduler.configure", { nodeId: "w1", change: { kind: "watcher", stat: "cpu", op: "gt", value: 90 } }));
    fails(decodeOverseerArgs("scheduler.configure", { nodeId: "n1", change: { kind: "note", text: "x" } }));
    fails(decodeOverseerArgs("scheduler.configure", { nodeId: "c1", timer: { kind: "cron" } }));
    fails(decodeOverseerArgs("scheduler.configure", { nodeId: "c1", change: { kind: "cron" }, watch: null }));
  });

  it("classifies uncertain or side-effecting reads conservatively", () => {
    const mutations = new Map(
      OVERSEER_CATALOG.map(({ operation, mutation }) => [operation, mutation]),
    );
    expect(mutations.get("canvas.read")).toBe(false);
    expect(mutations.get("msg.list")).toBe(true);
    expect(mutations.get("page.eval")).toBe(true);
    expect(mutations.get("page.screenshot")).toBe(true);
    expect(mutations.get("canvas.screenshot")).toBe(true);
  });

  it("defines strict typed Station result envelopes", () => {
    succeeds(
      decodeOverseerCaller({ canvasName: "work", nodeId: "agent-1" }),
    );
    fails(
      decodeOverseerCaller({
        canvasName: "work",
        nodeId: "agent-1",
        installationId: "client-claimed",
      }),
    );
    succeeds(
      decodeOverseerResult({
        ok: true,
        operation: "node.get",
        data: { id: "node-1" },
      }),
    );
    succeeds(
      decodeOverseerResult({
        ok: false,
        operation: "node.get",
        error: { type: "NotFound", message: "node not found" },
      }),
    );
    fails(
      decodeOverseerResult({
        ok: false,
        operation: "node.get",
        error: { type: "UnknownTarget", message: "node not found" },
      }),
    );
    fails(
      decodeOverseerResult({
        ok: true,
        operation: "node.get",
        data: null,
        extra: true,
      }),
    );
    fails(
      decodeOverseerResult({
        ok: false,
        operation: "node.get",
        error: { type: "InternalError", message: "é".repeat(2_049) },
      }),
    );
    expect(OVERSEER_MAX_REQUEST_BYTES).toBe(1024 * 1024);
  });

  it("fits a maximum result and escaped correlation id in real transport frame budgets", () => {
    const result = maximumResult();
    expect(jsonBytes(result)).toBe(OVERSEER_MAX_RESULT_BYTES);

    // Parent admission applies this bound to JSON.stringify(req.id). A string
    // of backslashes proves escaping, rather than character count, controls it.
    const maximumCorrelationId = "\\".repeat(
      (OVERSEER_MAX_CORRELATION_BYTES - 2) / 2,
    );
    expect(jsonBytes(maximumCorrelationId)).toBe(
      OVERSEER_MAX_CORRELATION_BYTES,
    );
    expect(jsonBytes(`${maximumCorrelationId}\\`)).toBeGreaterThan(
      OVERSEER_MAX_CORRELATION_BYTES,
    );

    const workWithoutId = encodeWorkFrame({
      ok: true,
      op: "overseer",
      data: result,
      protocol_version: WORK_PROTOCOL_VERSION,
    });
    const workWithMaximumId = encodeWorkFrame({
      ok: true,
      op: "overseer",
      data: result,
      id: maximumCorrelationId,
      protocol_version: WORK_PROTOCOL_VERSION,
    });
    expect(Buffer.byteLength(workWithoutId, "utf8")).toBeLessThanOrEqual(
      WORK_MAX_FRAME_BYTES,
    );
    expect(Buffer.byteLength(workWithMaximumId, "utf8")).toBeLessThanOrEqual(
      WORK_MAX_FRAME_BYTES,
    );

    // This is the closed Station overseer response nested in the existing
    // control and session envelopes. The Station contract owns the schemas;
    // this test owns the cross-transport byte-budget invariant.
    const stationFrame = encodeStationControlFrame({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId: "r".repeat(64),
      envelope: {
        protocol: STATION_CONTROL_PROTOCOL,
        ok: true,
        response: {
          protocol: STATION_API_PROTOCOL,
          op: "overseer",
          senderInstallationId: "s".repeat(128),
          targetInstallationId: "t".repeat(128),
          caller: {
            canvasName: "c".repeat(64),
            nodeId: "n".repeat(256),
          },
          result,
        },
      },
    });
    expect(Buffer.byteLength(stationFrame, "utf8")).toBeLessThanOrEqual(
      STATION_CONTROL_MAX_FRAME_BYTES,
    );
  });

  it("accepts ContentService-compatible expected identity on bounded ingest", () => {
    succeeds(
      decodeOverseerArgs("content.ingest", {
        bytesBase64: "aGVsbG8=",
        mediaType: "text/plain",
        displayName: "hello.txt",
        expected: {
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          byteLength: 5,
        },
      }),
    );
  });
});
