import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import { selectFactoryClaims } from "../src/shared/factory-tick";
import { deriveActorSeatId } from "../src/main/vellum/station/actor-seat-compiler";
import { isManagedSeatRuntimeLocal } from "../src/main/vellum/term/ensure-managed-seat";
import {
  activeActorRegistry,
  actorSeatSelectableNow,
  managedTaskDeliveryId,
} from "../src/main/vellum/kernel/service";

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

describe("kernel actor and delivery identity", () => {
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

  it("derives a bounded stable delivery id from the full work identity", () => {
    const sink = { canvasName: "factory", nodeId: "tasks" };
    const seatId = deriveActorSeatId(
      installation("remote-a"),
      "binding-alpha",
    );
    const delivery = managedTaskDeliveryId(sink, "task-1", seatId);

    expect(delivery).toMatch(/^delivery_[a-f0-9]{64}$/u);
    expect(managedTaskDeliveryId(sink, "task-1", seatId)).toBe(delivery);
    expect(managedTaskDeliveryId(sink, "task-2", seatId)).not.toBe(delivery);
  });

  it("selects a local actor only after its managed seat is ready to receive work", async () => {
    const installationId = installation("command-center");
    const node = actorNode("local");
    const actor = authority(installationId, "local", node).actor;
    const scope = {
      role: "command-center" as const,
      hostId: "local",
      installationId,
    };
    const available = (ready: boolean) => ({
      isLocalSeatReady: () => ready,
      installationForHost: async () => undefined,
      isLive: async () => false,
    });

    expect(
      await actorSeatSelectableNow(
        "factory",
        node,
        actor,
        scope,
        available(false),
      ),
    ).toBe(false);
    expect(
      await actorSeatSelectableNow(
        "factory",
        node,
        actor,
        scope,
        available(true),
      ),
    ).toBe(true);
  });

  it("never selects a foreign actor from a Remote projection", async () => {
    const node = actorNode("box-b");
    const actor = {
      seatId: deriveActorSeatId(
        installation("remote-b"),
        "binding-alpha",
      ),
      canvasName: "factory",
      nodeId: node.id,
    };

    expect(
      await actorSeatSelectableNow(
        "factory",
        node,
        actor,
        {
          role: "remote",
          hostId: "box-a",
          installationId: installation("remote-a"),
        },
        {
          isLocalSeatReady: () => false,
          installationForHost: async () => installation("remote-b"),
          isLive: async () => true,
        },
      ),
    ).toBe(false);
  });

  it("skips an offline first actor and lets the live second actor claim", async () => {
    const offlineInstallation = installation("remote-offline");
    const liveInstallation = installation("remote-live");
    const offline = actorNode(
      "box-offline",
      "binding-offline",
      "a-offline",
    );
    const live = actorNode("box-live", "binding-live", "b-live");
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "tasks",
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "tasks",
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [
                {
                  id: "task-1",
                  state: "submitted",
                  history: [
                    {
                      messageId: "brief-1",
                      role: "user",
                      parts: [{ kind: "text", text: "ship it" }],
                      contextId: "factory",
                      taskId: "task-1",
                    },
                  ],
                },
              ],
            },
          },
        },
        offline,
        live,
      ],
      edges: [
        { id: "e-offline", fromNode: "tasks", toNode: offline.id },
        { id: "e-live", fromNode: "tasks", toNode: live.id },
      ],
    };
    const actorRefs = [
      {
        seatId: deriveActorSeatId(
          offlineInstallation,
          "binding-offline",
        ),
        canvasName: "factory",
        nodeId: offline.id,
      },
      {
        seatId: deriveActorSeatId(liveInstallation, "binding-live"),
        canvasName: "factory",
        nodeId: live.id,
      },
    ];
    const registry = activeActorRegistry(actorRefs);
    const availability = {
      isLocalSeatReady: () => false,
      installationForHost: async (hostId: string) =>
        hostId === "box-offline"
          ? offlineInstallation
          : hostId === "box-live"
            ? liveInstallation
            : undefined,
      isLive: async (hostId: string) => hostId === "box-live",
    };
    const scope = {
      role: "command-center" as const,
      hostId: "local",
      installationId: installation("command-center"),
    };
    const selectable = new Set(
      (
        await Promise.all(
          actorRefs.map(async (actor) => {
            const node = doc.nodes.find(
              (candidate) => candidate.id === actor.nodeId,
            )!;
            return (await actorSeatSelectableNow(
              "factory",
              node,
              actor,
              scope,
              availability,
            ))
              ? actor.seatId
              : undefined;
          }),
        )
      ).filter((seatId) => seatId !== undefined),
    );

    const selections = selectFactoryClaims(
      doc,
      "factory",
      registry.resolve,
      {
        actorEligible: (node) => {
          const actor = registry.resolve({
            canvasName: "factory",
            nodeId: node.id,
          });
          return actor !== undefined && selectable.has(actor.seatId);
        },
      },
    );

    expect(selectable).toEqual(new Set([actorRefs[1]!.seatId]));
    expect(selections).toEqual([
      {
        sink: { canvasName: "factory", nodeId: "tasks" },
        task: {
          kind: "task",
          itemId: "task-1",
          sink: { canvasName: "factory", nodeId: "tasks" },
        },
        actor: actorRefs[1],
      },
    ]);
  });
});
