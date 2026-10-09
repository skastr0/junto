import { describe, expect, it } from "vitest";
import {
  makeProcessIdentityMap,
  processAlive,
  readProcessStartKey,
} from "../src/main/junto/process-identity";

describe("process identity epoch", () => {
  it("binds only live PIDs and resolves with start-key match", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    expect(processAlive(pid)).toBe(true);
    expect(readProcessStartKey(pid)).toBeTruthy();
    expect(map.bind(pid, { agentKey: "local:default" })).toBe(true);
    expect(map.resolve(pid)?.agentKey).toBe("local:default");
    map.unbindAgentKey("local:default");
    expect(map.resolve(pid)).toBeUndefined();
  });

  it("refuses to overwrite a live PID with a different principal", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    expect(map.bind(pid, { agentKey: "local:a" })).toBe(true);
    expect(map.bind(pid, { agentKey: "local:b" })).toBe(false);
    expect(map.resolve(pid)?.agentKey).toBe("local:a");
    map.clear();
  });

  it("unbindAgentKey clears prior binds before rebind", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    map.bind(pid, { agentKey: "local:a" });
    map.unbindAgentKey("local:a");
    expect(map.bind(pid, { agentKey: "local:a" })).toBe(true);
    map.clear();
  });

  it("does not let a late generation witness erase a reused PID", () => {
    let startKey = "epoch-1";
    const map = makeProcessIdentityMap({
      processAlive: () => true,
      readProcessStartKey: () => startKey,
    });
    const prior = map.bindGeneration(42_101, {
      agentKey: "local:prior",
    });
    expect(prior).toBeDefined();

    startKey = "epoch-2";
    const replacement = map.bindGeneration(42_101, {
      agentKey: "local:replacement",
    });
    expect(replacement).toBeDefined();
    expect(map.unbindGeneration(prior!)).toBe(false);
    expect(map.resolve(42_101)).toEqual({
      agentKey: "local:replacement",
    });
    expect(map.unbindGeneration(replacement!)).toBe(true);
    expect(map.resolve(42_101)).toBeUndefined();
  });

  it("binds and unbinds canvas-anchored terminal principals", () => {
    const map = makeProcessIdentityMap();
    const principal = {
      kind: "terminal" as const,
      bindingId: "term-1",
      canvasName: "main",
      nodeId: "node-1",
    };
    expect(map.bind(process.pid, principal)).toBe(true);
    expect(map.resolve(process.pid)).toEqual(principal);
    map.unbindTerminalBinding("term-1");
    expect(map.resolve(process.pid)).toBeUndefined();
  });

  it("rejects terminal principals without a canvas anchor", () => {
    const map = makeProcessIdentityMap();
    expect(map.bind(process.pid, { bindingId: "term-1" })).toBe(false);
  });
});
