import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeActorSeatOccupy,
  type ActorOccupySpec,
} from "../src/main/vellum/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

const actorSpec = (bindingId: string, hostId?: string): ActorOccupySpec => ({
  bindingId,
  harness: "grok",
  agentKey: "local:grok",
  launch: { kind: "harness", argv: ["grok"] },
  ...(hostId === undefined ? {} : { hostId }),
});

const remoteSummary = (
  over: Pick<TerminalSessionSummary, "bindingId" | "epoch" | "status"> &
    Partial<Pick<TerminalSessionSummary, "harness" | "agentKey">>,
): TerminalSessionSummary => ({
  hostId: "station-a",
  detached: false,
  createdAt: 1,
  ...over,
});

beforeEach(() => {
  syntheticEpochs.clear();
  setProcessEpochReaderForTests({
    snapshot: () =>
      [...syntheticEpochs].map(([pid, startKey]) => ({
        pid,
        processGroupId: Math.max(2, pid - 1),
        sessionId: 7,
        startKey,
      })),
  });
});

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.shutdownAll("test_cleanup");
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

describe("ActorSeatOccupy", () => {
  it("occupies a vacant local seat through createAgentSeat", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_700, "synthetic-42700");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_700,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const createAgentSeat = vi.spyOn(host, "createAgentSeat");
    const create = vi.spyOn(host, "create");
    const when = makeActorSeatOccupy({
      local: host,
      isLocalHostId: () => true,
      clientFor: async () => {
        throw new Error("local occupy must not open a remote client");
      },
    });

    const created = await Effect.runPromise(when.occupy(actorSpec("seat-p")));
    expect(created.status).toBe("running");
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("local:grok");
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(fake.controllers).toHaveLength(1);

    const occupancy = await Effect.runPromise(when.occupancy("seat-p"));
    expect(occupancy._tag).toBe("OccupiedSeat");

    const refused = await Effect.runPromiseExit(when.occupy(actorSpec("seat-p")));
    expect(Exit.isFailure(refused)).toBe(true);
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("occupies a vacant remote seat through createAgentSeat once", async () => {
    let createAgentSeatCalls = 0;
    const created = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-new",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const host = new LocalSessionHost(
      makeFakeTerminalProcessAuthority().authority,
    );
    hosts.push(host);
    const when = makeActorSeatOccupy({
      local: host,
      isLocalHostId: () => false,
      clientFor: async () => ({
        get: async () => undefined,
        createAgentSeat: async (input) => {
          createAgentSeatCalls += 1;
          expect(input.harness).toBe("grok");
          expect(input.agentKey).toBe("local:grok");
          return created;
        },
      }),
    });

    const summary = await Effect.runPromise(
      when.occupy(actorSpec("seat-r", "station-a")),
    );
    expect(summary.epoch).toBe("epoch-new");
    expect(summary.harness).toBe("grok");
    expect(createAgentSeatCalls).toBe(1);
  });

  it("refuses occupy on an occupied remote seat without createAgentSeat", async () => {
    let createAgentSeatCalls = 0;
    const live = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-1",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const host = new LocalSessionHost(
      makeFakeTerminalProcessAuthority().authority,
    );
    hosts.push(host);
    const when = makeActorSeatOccupy({
      local: host,
      isLocalHostId: () => false,
      clientFor: async () => ({
        get: async () => live,
        createAgentSeat: async () => {
          createAgentSeatCalls += 1;
          return live;
        },
      }),
    });

    const refused = await Effect.runPromiseExit(
      when.occupy(actorSpec("seat-r", "station-a")),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(createAgentSeatCalls).toBe(0);

    const occupancy = await Effect.runPromise(
      when.occupancy("seat-r", "station-a"),
    );
    expect(occupancy).toMatchObject({
      _tag: "OccupiedSeat",
      placement: "remote",
      epoch: "epoch-1",
    });
  });
});
