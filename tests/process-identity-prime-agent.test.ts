import { describe, expect, it } from "vitest";
import { makeProcessIdentityMap } from "../src/main/vellum/process-identity";

const DAEMON_A = 10_100;
const WORKER_A = 10_101;
const SHELL_A = 10_102;
const TOOL_A = 10_103;
const DAEMON_B = 20_100;
const WORKER_B = 20_101;
const TOOL_B = 20_102;

const parents = new Map<number, number>([
  [TOOL_A, SHELL_A],
  [SHELL_A, WORKER_A],
  [WORKER_A, DAEMON_A],
  [DAEMON_A, 1],
  [TOOL_B, WORKER_B],
  [WORKER_B, DAEMON_B],
  [DAEMON_B, 1],
]);

const epochs = new Map<number, string>([
  [DAEMON_A, "daemon-a-1"],
  [DAEMON_B, "daemon-b-1"],
]);

const makeMap = () =>
  makeProcessIdentityMap({
    processAlive: (pid) => epochs.has(pid),
    readProcessStartKey: (pid) => epochs.get(pid),
    readParentPid: (pid) => parents.get(pid),
  });

describe("Prime Agent per-seat daemon ancestry", () => {
  it("attributes detached worker descendants to only their bound seat daemon", () => {
    const identities = makeMap();
    const principalA = {
      agentKey: "local:prime-agent",
      canvasName: "factory",
      nodeId: "agent-a",
    };
    const principalB = {
      agentKey: "local:prime-agent",
      canvasName: "factory",
      nodeId: "agent-b",
    };

    expect(identities.bindGeneration(DAEMON_A, principalA)).toBeDefined();
    expect(identities.bindGeneration(DAEMON_B, principalB)).toBeDefined();

    expect(identities.resolveInTree(TOOL_A)).toEqual(principalA);
    expect(identities.resolveInTree(TOOL_B)).toEqual(principalB);
    expect(identities.resolveInTree(999_999)).toBeUndefined();
  });

  it("revokes one exact daemon generation without touching another seat", () => {
    const identities = makeMap();
    const bindingA = identities.bindGeneration(DAEMON_A, {
      agentKey: "local:prime-agent",
      canvasName: "factory",
      nodeId: "agent-a",
    });
    const bindingB = identities.bindGeneration(DAEMON_B, {
      agentKey: "local:prime-agent",
      canvasName: "factory",
      nodeId: "agent-b",
    });
    expect(bindingA).toBeDefined();
    expect(bindingB).toBeDefined();

    expect(identities.unbindGeneration(bindingA!)).toBe(true);
    expect(identities.resolveInTree(TOOL_A)).toBeUndefined();
    expect(identities.resolveInTree(TOOL_B)?.nodeId).toBe("agent-b");
  });

  it("does not let late cleanup erase a replacement that reused the daemon PID", () => {
    const identities = makeMap();
    const prior = identities.bindGeneration(DAEMON_A, {
      agentKey: "local:prime-agent",
      canvasName: "factory",
      nodeId: "agent-a",
    });
    expect(prior).toBeDefined();

    epochs.set(DAEMON_A, "daemon-a-2");
    const replacement = identities.bindGeneration(DAEMON_A, {
      agentKey: "local:prime-agent",
      canvasName: "factory",
      nodeId: "agent-a-reopened",
    });
    expect(replacement).toBeDefined();
    expect(identities.unbindGeneration(prior!)).toBe(false);
    expect(identities.resolveInTree(TOOL_A)?.nodeId).toBe("agent-a-reopened");
  });

  it("denies the unbound shared/default daemon tree", () => {
    const identities = makeMap();
    expect(identities.resolveInTree(TOOL_A)).toBeUndefined();
    expect(identities.resolveInTree(TOOL_B)).toBeUndefined();
  });
});
