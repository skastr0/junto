import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import {
  makeLocalSeatProcess,
  makeRemoteSeatProcess,
} from "../src/main/vellum/term/seat-process";
import type { OccupySpec } from "../src/main/vellum/term/seat-process";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  occupancyFromSession,
  occupyVacantSeat,
  seatAdmission,
} from "../src/shared/terminal-seat-occupancy";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();

const actorSpec = (bindingId: string, hostId?: string): OccupySpec => ({
  bindingId,
  harness: "grok",
  agentKey: "local:grok",
  launch: { kind: "harness", argv: ["grok"] },
  ...(hostId === undefined ? {} : { hostId }),
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

describe("local TerminalSeatProcess", () => {
  it("occupies vacant seats and activates occupied ones", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_600, "synthetic-42600");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_600,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const seats = makeLocalSeatProcess(host);
    const vacant = occupancyFromSession("seat-p", undefined, "local");
    const occupy = occupyVacantSeat(vacant);
    if (occupy._tag !== "Success") throw new Error("expected occupy command");

    const created = await Effect.runPromise(
      seats.occupy(occupy.success, actorSpec("seat-p")),
    );
    expect(created.status).toBe("running");
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("local:grok");
    expect(fake.controllers).toHaveLength(1);

    const occupancy = await Effect.runPromise(seats.occupancy("seat-p"));
    expect(occupancy._tag).toBe("OccupiedSeat");
    const admission = seatAdmission(occupancy);
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const activated = await Effect.runPromise(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(activated.epoch).toBe(created.epoch);
    expect(activated.harness).toBe("grok");
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual([]);

    const refused = await Effect.runPromiseExit(
      seats.occupy(occupy.success, actorSpec("seat-p")),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(host.runningCount()).toBe(1);
  });

  it("adopts occupied geography and refuses a harness mismatch", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_601, "synthetic-42601");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_601,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const seats = makeLocalSeatProcess(host);
    const geo = host.create({
      bindingId: "seat-g",
      launch: { kind: "shell" },
    });
    expect(geo.harness).toBeUndefined();
    expect(fake.controllers).toHaveLength(1);

    const occupancy = await Effect.runPromise(seats.occupancy("seat-g"));
    const admission = seatAdmission(occupancy);
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const adopted = await Effect.runPromise(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(adopted.epoch).toBe(geo.epoch);
    expect(adopted.harness).toBe("grok");
    expect(adopted.agentKey).toBe("local:grok");
    expect(fake.controllers).toHaveLength(1);

    const mismatch = await Effect.runPromiseExit(
      seats.activate(admission, { harness: "claude", agentKey: "local:claude" }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(host.get("seat-g")?.harness).toBe("grok");
  });
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

describe("remote TerminalSeatProcess", () => {
  it("refuses occupy on an occupied seat and activates the same epoch", async () => {
    const live = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-1",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    let createAgentSeatCalls = 0;
    const seats = makeRemoteSeatProcess({
      get: async () => live,
      createAgentSeat: async () => {
        createAgentSeatCalls += 1;
        return live;
      },
    });
    const occupy = occupyVacantSeat(
      occupancyFromSession("seat-r", undefined, "remote"),
    );
    if (occupy._tag !== "Success") throw new Error("expected occupy command");

    const refused = await Effect.runPromiseExit(
      seats.occupy(occupy.success, actorSpec("seat-r", "station-a")),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(createAgentSeatCalls).toBe(0);

    const occupancy = await Effect.runPromise(seats.occupancy("seat-r"));
    expect(occupancy).toMatchObject({
      _tag: "OccupiedSeat",
      placement: "remote",
      epoch: "epoch-1",
    });
    const admission = seatAdmission(occupancy);
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const activated = await Effect.runPromise(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(activated.epoch).toBe(live.epoch);
    expect(createAgentSeatCalls).toBe(0);
  });

  it("occupies a vacant seat by creating an actor seat once", async () => {
    let createAgentSeatCalls = 0;
    const created = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-new",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const seats = makeRemoteSeatProcess({
      get: async () => undefined,
      createAgentSeat: async (input) => {
        createAgentSeatCalls += 1;
        expect(input.harness).toBe("grok");
        expect(input.agentKey).toBe("local:grok");
        return created;
      },
    });
    const occupy = occupyVacantSeat(
      occupancyFromSession("seat-r", undefined, "remote"),
    );
    if (occupy._tag !== "Success") throw new Error("expected occupy command");

    const summary = await Effect.runPromise(
      seats.occupy(occupy.success, actorSpec("seat-r", "station-a")),
    );
    expect(summary.epoch).toBe("epoch-new");
    expect(summary.harness).toBe("grok");
    expect(createAgentSeatCalls).toBe(1);
  });
});
