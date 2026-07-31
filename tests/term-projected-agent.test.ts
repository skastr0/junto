import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasReadResult } from "../src/shared/ipc";
import type { CanvasNode } from "../src/shared/canvas";
import {
  decodeTermProjectedAgentCreateRequest,
} from "../src/shared/term-control";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/vellum/station/actor-seat-compiler";
import {
  resolveProjectedAgentSeatInput,
} from "../src/main/vellum/term/projected-agent";

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const actorNode = (
  hostId = "box-a",
): CanvasNode => ({
  id: "agent-a",
  type: "text",
  x: 0,
  y: 0,
  width: 240,
  height: 100,
  text: "Remote agent",
  ether: {
    entity: { kind: "agent", name: `${hostId}:codex` },
    host: hostId,
    terminal: {
      bindingId: "binding-a",
      harness: "codex",
      label: "qualification agent",
      launch: {
        kind: "command",
        argv: ["/bin/sh"],
        cwd: "/tmp",
      },
    },
  },
});

const projectedRead = (
  installationId: InstallationIdValue,
  node = actorNode(),
): CanvasReadResult => ({
  name: "factory",
  doc: {
    nodes: [node],
    edges: [],
  },
  actorRefs: [{
    seatId: deriveActorSeatId(
      installationId,
      node.ether?.terminal?.bindingId ?? "",
    ),
    canvasName: "factory",
    nodeId: node.id,
  }],
  revision: "r1",
  workRevision: "w1",
});

describe("projected agent Term authority", () => {
  it("resolves every executable field from the active Remote projection", () => {
    const installationId = installation("remote-a");
    const resolved = resolveProjectedAgentSeatInput(
      projectedRead(installationId),
      { installationId, hostId: "box-a" },
      {
        canvasName: "factory",
        nodeId: "agent-a",
        cols: 90,
        rows: 30,
      },
    );

    expect(resolved).toEqual({
      bindingId: "binding-a",
      hostId: "box-a",
      canvasName: "factory",
      nodeId: "agent-a",
      label: "qualification agent",
      harness: "codex",
      agentKey: "box-a:codex",
      launch: {
        kind: "command",
        argv: ["/bin/sh"],
        cwd: "/tmp",
      },
      cols: 90,
      rows: 30,
    });
  });

  it("fails closed on foreign installation, placement, or ambiguous actor identity", () => {
    const local = installation("remote-a");
    const read = projectedRead(local);

    expect(() =>
      resolveProjectedAgentSeatInput(
        read,
        {
          installationId: installation("remote-b"),
          hostId: "box-a",
        },
        { canvasName: "factory", nodeId: "agent-a" },
      ),
    ).toThrow(/not local/u);
    expect(() =>
      resolveProjectedAgentSeatInput(
        read,
        { installationId: local, hostId: "box-b" },
        { canvasName: "factory", nodeId: "agent-a" },
      ),
    ).toThrow(/not local/u);
    expect(() =>
      resolveProjectedAgentSeatInput(
        {
          ...read,
          actorRefs: [
            ...read.actorRefs,
            {
              ...read.actorRefs[0]!,
              seatId: deriveActorSeatId(
                installation("remote-c"),
                "binding-a",
              ),
            },
          ],
        },
        { installationId: local, hostId: "box-a" },
        { canvasName: "factory", nodeId: "agent-a" },
      ),
    ).toThrow(/exactly one compiled actor/u);
  });

  it("strictly excludes caller-supplied argv, harness, binding, and identity claims", () => {
    const valid = {
      v: 1,
      id: "request-1",
      op: "agent.create",
      canvasName: "factory",
      nodeId: "agent-a",
      cols: 80,
      rows: 24,
    };
    expect(decodeTermProjectedAgentCreateRequest(valid)).toEqual(valid);

    for (const extra of [
      { launch: { kind: "command", argv: ["/bin/sh"] } },
      { argv: ["/bin/sh"] },
      { harness: "codex" },
      { bindingId: "binding-a" },
      { agentKey: "box-a:codex" },
      { nodeRef: "factory:agent-a" },
    ]) {
      expect(
        decodeTermProjectedAgentCreateRequest({
          ...valid,
          ...extra,
        }),
      ).toBeUndefined();
    }
  });
});
