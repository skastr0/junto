import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import type { HarnessId } from "../src/shared/managed-terminal-templates";
import {
  compileActorSeatRegistry,
  deriveActorSeatId,
} from "../src/main/junto/station/actor-seat-compiler";

const installation = (value: string) =>
  Schema.decodeUnknownSync(InstallationId)(value);

const managedActorDoc = (
  input: {
    readonly nodeId: string;
    readonly hostId: string;
    readonly bindingId: string;
    readonly agentKey?: string;
    readonly harness?: HarnessId;
    readonly argv?: ReadonlyArray<string>;
    readonly sessionId?: string;
    readonly overseer?: boolean;
  },
): CanvasDoc => ({
  nodes: [
    {
      id: input.nodeId,
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: input.agentKey ?? `${input.hostId}:worker`,
      ether: {
        entity: {
          kind: "agent",
          name: input.agentKey ?? `${input.hostId}:worker`,
        },
        ...(input.overseer === undefined
          ? {}
          : { overseer: input.overseer }),
        host: input.hostId,
        terminal: {
          bindingId: input.bindingId,
          harness: input.harness ?? "codex",
          launch: {
            kind: "harness",
            argv: [...(input.argv ?? [input.harness ?? "codex"])],
          },
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
        },
      },
    },
  ],
  edges: [],
});

describe("actor-seat compiler", () => {
  it("derives the exact stable identity from installation and binding", () => {
    const command = installation("install-command");

    expect(deriveActorSeatId(command, "binding-1")).toBe(
      "seat_9f5c62b7df53d578024e84744ea30f8ce422da1fd086e41beacdde4bbe3da3ca",
    );
    expect(deriveActorSeatId(command, " binding-1 ")).toBe(
      deriveActorSeatId(command, "binding-1"),
    );
    expect(deriveActorSeatId(command, "binding-2")).not.toBe(
      deriveActorSeatId(command, "binding-1"),
    );
    expect(deriveActorSeatId(installation("install-remote"), "binding-1"))
      .not.toBe(deriveActorSeatId(command, "binding-1"));
  });

  it("collapses identical cross-canvas aliases and chooses a sorted primary ref", () => {
    const command = installation("install-command");
    const documents = new Map<string, CanvasDoc>([
      [
        "zeta",
        managedActorDoc({
          nodeId: "agent-z",
          hostId: "local",
          bindingId: "binding-1",
          overseer: true,
        }),
      ],
      [
        "alpha",
        managedActorDoc({
          nodeId: "agent-a",
          hostId: "local",
          bindingId: "binding-1",
          overseer: true,
        }),
      ],
    ]);

    const registry = compileActorSeatRegistry(
      documents,
      new Map([["local", command]]),
    );

    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      authorityInstallationId: command,
      hostId: "local",
      overseer: true,
      bindingId: "binding-1",
      primaryRef: { canvasName: "alpha", nodeId: "agent-a" },
      refs: [
        { canvasName: "alpha", nodeId: "agent-a" },
        { canvasName: "zeta", nodeId: "agent-z" },
      ],
    });
  });

  it("keeps the same binding distinct on different authority installations", () => {
    const registry = compileActorSeatRegistry(
      new Map([
        [
          "alpha",
          managedActorDoc({
            nodeId: "agent-a",
            hostId: "remote-a",
            bindingId: "shared-binding",
            agentKey: "remote-a:codex",
          }),
        ],
        [
          "zeta",
          managedActorDoc({
            nodeId: "agent-z",
            hostId: "remote-z",
            bindingId: "shared-binding",
            agentKey: "remote-z:codex",
          }),
        ],
      ]),
      new Map([
        ["remote-a", installation("install-a")],
        ["remote-z", installation("install-z")],
      ]),
    );

    expect(registry).toHaveLength(2);
    expect(new Set(registry.map((seat) => seat.seatId)).size).toBe(2);
  });

  it("rejects unresolved placements and incomplete actor surfaces", () => {
    const document = managedActorDoc({
      nodeId: "agent-a",
      hostId: "missing",
      bindingId: "binding-1",
    });
    expect(() =>
      compileActorSeatRegistry(
        new Map([["alpha", document]]),
        new Map(),
      )
    ).toThrow("unresolved host");

    const incomplete: CanvasDoc = {
      ...document,
      nodes: document.nodes.map((node) => ({
        ...node,
        ether: {
          entity: { kind: "agent", name: "local:codex" },
          host: "local",
        },
      })),
    };
    expect(() =>
      compileActorSeatRegistry(
        new Map([["alpha", incomplete]]),
        new Map([["local", installation("install-command")]]),
      )
    ).toThrow("no complete managed execution surface");
  });

  it("rejects duplicate same-canvas references to one seat", () => {
    const first = managedActorDoc({
      nodeId: "agent-a",
      hostId: "local",
      bindingId: "binding-1",
    }).nodes[0]!;
    const duplicate: CanvasDoc = {
      nodes: [
        first,
        {
          ...first,
          id: "agent-b",
        },
      ],
      edges: [],
    };

    expect(() =>
      compileActorSeatRegistry(
        new Map([["alpha", duplicate]]),
        new Map([["local", installation("install-command")]]),
      )
    ).toThrow("appears more than once");
  });

  it("rejects conflicting executable descriptors for one seat", () => {
    expect(() =>
      compileActorSeatRegistry(
        new Map([
          [
            "alpha",
            managedActorDoc({
              nodeId: "agent-a",
              hostId: "local",
              bindingId: "binding-1",
              harness: "codex",
              argv: ["codex"],
            }),
          ],
          [
            "zeta",
            managedActorDoc({
              nodeId: "agent-z",
              hostId: "local",
              bindingId: "binding-1",
              harness: "claude",
              argv: ["claude"],
            }),
          ],
        ]),
        new Map([["local", installation("install-command")]]),
      )
    ).toThrow("conflicting executable descriptors");
  });

  it("keeps absent authority ordinary and rejects overseer alias disagreement", () => {
    const command = installation("install-command");
    const ordinary = compileActorSeatRegistry(
      new Map([
        [
          "alpha",
          managedActorDoc({
            nodeId: "agent-a",
            hostId: "local",
            bindingId: "binding-1",
          }),
        ],
      ]),
      new Map([["local", command]]),
    );
    expect(ordinary[0]?.overseer).toBeUndefined();

    expect(() =>
      compileActorSeatRegistry(
        new Map([
          [
            "alpha",
            managedActorDoc({
              nodeId: "agent-a",
              hostId: "local",
              bindingId: "binding-1",
              overseer: true,
            }),
          ],
          [
            "zeta",
            managedActorDoc({
              nodeId: "agent-z",
              hostId: "local",
              bindingId: "binding-1",
            }),
          ],
        ]),
        new Map([["local", command]]),
      )
    ).toThrow("conflicting executable descriptors");
  });
});
