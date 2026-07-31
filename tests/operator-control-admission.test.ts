import { describe, expect, it } from "vitest";
import type { Socket } from "node:net";
import {
  admitOperatorPeer,
} from "../src/main/vellum/operator-control/admission";
import type { ProcessIdentityMap } from "../src/main/vellum/process-identity";

const socket = {} as Socket;

const processMapWith = (
  pids: ReadonlyArray<number>,
): ProcessIdentityMap =>
  ({
    snapshot: () =>
      pids.map((pid) => ({
        pid,
        principal: { agentKey: `local:test-${String(pid)}` },
        startKey: "test-start",
      })),
  }) as unknown as ProcessIdentityMap;

describe("operator control peer admission", () => {
  it("fails closed when the kernel peer PID is unavailable", () => {
    expect(
      admitOperatorPeer(socket, {
        processMap: processMapWith([]),
        readPeerPid: () => undefined,
      }),
    ).toEqual({ ok: false, reason: "peer-pid-unavailable" });
  });

  it("rejects a peer or ancestor registered to a Vellum process", () => {
    const parents = new Map([
      [410, 320],
      [320, 20],
      [20, 1],
    ]);
    expect(
      admitOperatorPeer(socket, {
        processMap: processMapWith([320]),
        readPeerPid: () => 410,
        readParentPid: (pid) => parents.get(pid),
      }),
    ).toEqual({ ok: false, reason: "registered-process-tree" });
  });

  it("admits only after a complete unregistered walk reaches PID 1", () => {
    const parents = new Map([
      [410, 320],
      [320, 20],
      [20, 1],
    ]);
    expect(
      admitOperatorPeer(socket, {
        processMap: processMapWith([999]),
        readPeerPid: () => 410,
        readParentPid: (pid) => parents.get(pid),
      }),
    ).toEqual({ ok: true, peerPid: 410 });
  });

  it.each([
    {
      name: "missing parent",
      parent: (_pid: number): number | undefined => undefined,
      maxDepth: undefined,
    },
    {
      name: "ancestry cycle",
      parent: (pid: number): number | undefined => pid === 410 ? 320 : 410,
      maxDepth: undefined,
    },
    {
      name: "depth exhaustion",
      parent: (pid: number): number | undefined => pid - 1,
      maxDepth: 2,
    },
  ])("denies $name as indeterminate", ({ parent, maxDepth }) => {
    expect(
      admitOperatorPeer(socket, {
        processMap: processMapWith([]),
        readPeerPid: () => 410,
        readParentPid: parent,
        ...(maxDepth === undefined ? {} : { maxDepth }),
      }),
    ).toEqual({ ok: false, reason: "ancestry-indeterminate" });
  });
});
