import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  OVERSEER_CATALOG,
  OVERSEER_MAX_REQUEST_BYTES,
  OVERSEER_MAX_RESULT_BYTES,
  OVERSEER_OPERATION_NAMES,
  OverseerArgsSchemas,
  decodeOverseerArgs,
  decodeOverseerCaller,
  decodeOverseerRequest,
  decodeOverseerResult,
} from "../src/shared/overseer-control";

const succeeds = (result: Result.Result<unknown, unknown>): void => {
  expect(Result.isSuccess(result)).toBe(true);
};

const fails = (result: Result.Result<unknown, unknown>): void => {
  expect(Result.isFailure(result)).toBe(true);
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

  it("accepts a strict CanvasNode-shaped draft without an id", () => {
    const draft = {
      node: {
        type: "text",
        text: "new task board",
        x: 12,
        y: 24,
        width: 240,
        height: 120,
        ether: {
          entity: { kind: "task" },
          tasks: { name: "Ready" },
        },
      },
    };
    succeeds(decodeOverseerArgs("node.create", draft));
    fails(
      decodeOverseerArgs("node.create", {
        ...draft,
        node: { ...draft.node, arbitrary: true },
      }),
    );
  });

  it("makes overseer grant minting and revocation unrepresentable in node changes", () => {
    succeeds(
      decodeOverseerArgs("node.configure", {
        nodeId: "agent-2",
        changes: { ether: { flags: ["attention"], watch: null } },
      }),
    );
    fails(
      decodeOverseerArgs("node.configure", {
        nodeId: "agent-2",
        changes: { ether: { overseer: true } },
      }),
    );
    fails(
      decodeOverseerArgs("node.configure", {
        nodeId: "agent-2",
        changes: { ether: null },
      }),
    );
    fails(
      decodeOverseerArgs("node.create", {
        node: {
          type: "text",
          text: "agent",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: { entity: { kind: "agent" }, overseer: true },
        },
      }),
    );
  });

  it("validates operation semantics rather than only object shape", () => {
    fails(
      decodeOverseerArgs("tasks.update", {
        target: "tasks-1",
        task: "task-1",
        state: "working",
        next: "tasks-2",
      }),
    );
    succeeds(
      decodeOverseerArgs("tasks.update", {
        target: "tasks-1",
        task: "task-1",
        state: "completed",
        next: "tasks-2",
      }),
    );
    fails(
      decodeOverseerArgs("edge.connect", {
        edge: { fromNode: "a", toNode: "b", verb: "arbitrary" },
      }),
    );
    fails(
      decodeOverseerArgs("agent.reseat", {
        nodeId: "agent-2",
      }),
    );
    succeeds(
      decodeOverseerArgs("agent.reseat", {
        nodeId: "agent-2",
        harness: "codex",
        model: "gpt-5",
      }),
    );
  });

  it("classifies uncertain or side-effecting reads conservatively", () => {
    const mutations = new Map(
      OVERSEER_CATALOG.map(({ operation, mutation }) => [operation, mutation]),
    );
    expect(mutations.get("canvas.read")).toBe(false);
    expect(mutations.get("tasks.rules")).toBe(false);
    expect(mutations.get("msg.list")).toBe(true);
    expect(mutations.get("pad.read")).toBe(true);
    expect(mutations.get("page.eval")).toBe(true);
    expect(mutations.get("page.screenshot")).toBe(true);
    expect(mutations.get("canvas.screenshot")).toBe(true);
  });

  it("defines strict typed Station result envelopes and transport byte budgets", () => {
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
    expect(OVERSEER_MAX_RESULT_BYTES).toBe(8 * 1024 * 1024);
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
