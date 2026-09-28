import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/junto/station/actor-seat-compiler";
import { isManagedSeatRuntimeLocal } from "../src/main/junto/term/ensure-managed-seat";
import { activeActorRegistry } from "../src/main/junto/kernel/service";

const actorNode = (
  hostId: string,
  bindingId = "binding-alpha",
  nodeId = "actor",
): CanvasNode => ({
  id: nodeId,
  type: "text",
  x: 0,
  y: 0,
  width: 240,
  height: 100,
  text: "actor",
  ether: {
    entity: { kind: "agent", name: `${hostId}:codex` },
    host: hostId,
    terminal: {
      bindingId,
      harness: "codex",
    },
  },
});

const authority = (
  installationId: InstallationIdValue,
  hostId: string,
  node = actorNode(hostId),
) => ({
  actor: {
    seatId: deriveActorSeatId(
      installationId,
      node.ether?.terminal?.bindingId ?? "",
    ),
    canvasName: "factory",
    nodeId: node.id,
  },
  installationId,
  hostId,
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

describe("managed actor runtime locality", () => {
  it("admits the exact compiled actor seat on its installation and host", () => {
    const node = actorNode("box-a");

    expect(
      isManagedSeatRuntimeLocal(
        "factory",
        node,
        authority(installation("remote-a"), "box-a", node),
      ),
    ).toBe(true);
  });

  it("rejects a foreign installation even when its HostId text matches", () => {
    const node = actorNode("box-a");
    const local = authority(installation("remote-a"), "box-a", node);
    const foreignSeat = deriveActorSeatId(
      installation("remote-b"),
      "binding-alpha",
    );

    expect(
      isManagedSeatRuntimeLocal("factory", node, {
        ...local,
        actor: { ...local.actor, seatId: foreignSeat },
      }),
    ).toBe(false);
  });

  it("rejects foreign placement and canvas-local reference substitution", () => {
    const node = actorNode("box-b");
    const local = authority(
      installation("remote-a"),
      "box-a",
      actorNode("box-a"),
    );

    expect(isManagedSeatRuntimeLocal("factory", node, local)).toBe(false);
    expect(
      isManagedSeatRuntimeLocal("another-canvas", actorNode("box-a"), local),
    ).toBe(false);
    expect(
      isManagedSeatRuntimeLocal("factory", { ...actorNode("box-a"), id: "other" }, local),
    ).toBe(false);
  });
});

describe("kernel actor identity", () => {
  it("resolves exact canvas-scoped actor refs and fails closed on duplicates", () => {
    const seatId = deriveActorSeatId(
      installation("remote-a"),
      "binding-alpha",
    );
    const actor = {
      seatId,
      canvasName: "factory",
      nodeId: "actor",
    };
    const registry = activeActorRegistry([actor]);

    expect(
      registry.resolve({ canvasName: "factory", nodeId: "actor" }),
    ).toEqual(actor);
    expect(registry.actorOnCanvas(seatId, "factory")).toEqual(actor);
    expect(
      registry.resolve({ canvasName: "other", nodeId: "actor" }),
    ).toBeUndefined();

    const ambiguous = activeActorRegistry([
      actor,
      {
        ...actor,
        seatId: deriveActorSeatId(
          installation("remote-b"),
          "binding-alpha",
        ),
      },
    ]);
    expect(
      ambiguous.resolve({ canvasName: "factory", nodeId: "actor" }),
    ).toBeUndefined();
  });
});
