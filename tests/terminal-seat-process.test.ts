import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import {
  makeLocalSeatProcess,
  makeRemoteSeatProcess,
} from "../src/main/vellum/term/seat-process";
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
      seats.occupy(occupy.success, {
        bindingId: "seat-p",
        launch: { kind: "shell" },
      }),
    );
    expect(created.status).toBe("running");
    expect(fake.controllers).toHaveLength(1);

    const occupancy = await Effect.runPromise(seats.occupancy("seat-p"));
    expect(occupancy._tag).toBe("OccupiedSeat");
    const admission = seatAdmission(occupancy);
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const activated = await Effect.runPromise(seats.activate(admission));
    expect(activated.epoch).toBe(created.epoch);
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual([]);

    const refused = await Effect.runPromiseExit(
      seats.occupy(occupy.success, {
        bindingId: "seat-p",
        launch: { kind: "shell" },
      }),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(host.runningCount()).toBe(1);
  });
});

const remoteSummary = (
  over: Pick<TerminalSessionSummary, "bindingId" | "epoch" | "status">,
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
    });
    let createCalls = 0;
    const seats = makeRemoteSeatProcess({
      get: async () => live,
      create: async () => {
        createCalls += 1;
        return live;
      },
    });
    const occupy = occupyVacantSeat(
      occupancyFromSession("seat-r", undefined, "remote"),
    );
    if (occupy._tag !== "Success") throw new Error("expected occupy command");

    const refused = await Effect.runPromiseExit(
      seats.occupy(occupy.success, {
        bindingId: "seat-r",
        launch: { kind: "shell" },
      }),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(createCalls).toBe(0);

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
    const activated = await Effect.runPromise(seats.activate(admission));
    expect(activated.epoch).toBe(live.epoch);
    expect(createCalls).toBe(0);
  });

  it("occupies a vacant seat by creating once", async () => {
    let createCalls = 0;
    const created = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-new",
      status: "running",
    });
    const seats = makeRemoteSeatProcess({
      get: async () => undefined,
      create: async () => {
        createCalls += 1;
        return created;
      },
    });
    const occupy = occupyVacantSeat(
      occupancyFromSession("seat-r", undefined, "remote"),
    );
    if (occupy._tag !== "Success") throw new Error("expected occupy command");

    const summary = await Effect.runPromise(
      seats.occupy(occupy.success, {
        bindingId: "seat-r",
        launch: { kind: "shell" },
      }),
    );
    expect(summary.epoch).toBe("epoch-new");
    expect(createCalls).toBe(1);
  });
});
