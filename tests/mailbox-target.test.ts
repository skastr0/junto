import { describe, expect, it } from "vitest";
import {
  isOwnMailboxTarget,
  resolveMailboxTarget,
} from "../src/shared/mailbox-target";

const caller = { canvasName: "factory", nodeId: "agent-01ABC" };

describe("resolveMailboxTarget", () => {
  it("defaults omitted and empty to the caller", () => {
    expect(resolveMailboxTarget(undefined, caller)).toBe(caller.nodeId);
    expect(resolveMailboxTarget("", caller)).toBe(caller.nodeId);
    expect(resolveMailboxTarget("   ", caller)).toBe(caller.nodeId);
  });

  it("accepts the bare node id and canvas:nodeId env form", () => {
    expect(resolveMailboxTarget(caller.nodeId, caller)).toBe(caller.nodeId);
    expect(resolveMailboxTarget(`factory:${caller.nodeId}`, caller)).toBe(
      caller.nodeId,
    );
  });

  it("resolves a same-canvas peer prefix and leaves a raw peer id", () => {
    expect(resolveMailboxTarget("factory:agent-peer", caller)).toBe("agent-peer");
    expect(resolveMailboxTarget("agent-peer", caller)).toBe("agent-peer");
  });

  it("does not rewrite a different-canvas prefix", () => {
    expect(resolveMailboxTarget("other:agent-01ABC", caller)).toBe(
      "other:agent-01ABC",
    );
  });

  it("isOwnMailboxTarget is the caller node only", () => {
    expect(isOwnMailboxTarget(caller.nodeId, caller.nodeId)).toBe(true);
    expect(isOwnMailboxTarget("agent-peer", caller.nodeId)).toBe(false);
  });
});
