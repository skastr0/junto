import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import {
  makeLocalSeatProcess,
  makeRemoteSeatProcess,
  type OccupySpec,
  type RemoteAgentSeatInput,
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

const actorSpec = (bindingId: string, hostId?: string): OccupySpec => ({
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
  hostId: "local",
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

const vacantCommand = (bindingId: string, placement: "local" | "remote") => {
  const command = occupyVacantSeat(
    occupancyFromSession(bindingId, undefined, placement),
  );
  if (command._tag !== "Success") throw new Error("expected occupy command");
  return command.success;
};

describe("local TerminalSeatProcess", () => {
  it("occupies vacant seats, activates occupied ones, and rejects an occupy race", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_600, "synthetic-42600");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_600,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const seats = makeLocalSeatProcess(host);
    const occupy = vacantCommand("seat-p", "local");

    const created = await Effect.runPromise(
      seats.occupy(occupy, actorSpec("seat-p")),
    );
    expect(created.status).toBe("running");
    expect(created.harness).toBe("grok");
    expect(created.agentKey).toBe("local:grok");
    expect(fake.controllers).toHaveLength(1);

    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-p")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const activated = await Effect.runPromise(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(activated.epoch).toBe(created.epoch);
    expect(fake.controllers).toHaveLength(1);
    expect(fake.controllers[0]?.signals).toEqual([]);

    const raced = await Effect.runPromiseExit(
      seats.occupy(occupy, actorSpec("seat-p")),
    );
    expect(Exit.isFailure(raced)).toBe(true);
    expect(host.runningCount()).toBe(1);
  });

  it("adopts occupied geography and refuses a different harness", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    syntheticEpochs.set(42_601, "synthetic-42601");
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 42_601,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority);
    hosts.push(host);
    const seats = makeLocalSeatProcess(host);
    const geography = host.create({
      bindingId: "seat-g",
      launch: { kind: "shell" },
    });

    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-g")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }
    const adopted = await Effect.runPromise(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(adopted).toMatchObject({
      epoch: geography.epoch,
      harness: "grok",
      agentKey: "local:grok",
    });
    expect(fake.controllers).toHaveLength(1);

    const mismatch = await Effect.runPromiseExit(
      seats.activate(admission, {
        harness: "claude",
        agentKey: "local:claude",
      }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(host.get("seat-g")?.harness).toBe("grok");
  });

  it("flushes an immediately dead resume and returns its live replacement head", async () => {
    const priorHome = process.env.VELLUM_COMMAND_HOME;
    delete process.env.VELLUM_COMMAND_HOME;
    try {
      setProcessIdentityMapForTests(makeProcessIdentityMap());
      const fake = makeFakeTerminalProcessAuthority((_spec, index) => {
        const pid = 42_610 + index;
        syntheticEpochs.set(pid, `synthetic-${pid}`);
        return {
          pid,
          ...(index === 0 ? { exitImmediately: true as const } : {}),
          exitOnSignal: false,
        };
      });
      const host = new LocalSessionHost(fake.authority);
      hosts.push(host);
      const createAgentSeat = vi.spyOn(host, "createAgentSeat");
      const seats = makeLocalSeatProcess(host);

      const returned = await Effect.runPromise(
        seats.occupy(vacantCommand("seat-resume", "local"), {
          bindingId: "seat-resume",
          harness: "claude",
          agentKey: "local:claude",
          launch: {
            kind: "harness",
            argv: ["claude", "--resume", "dead-session-aaaaaaaa"],
          },
        }),
      );
      const initiallyReturned = createAgentSeat.mock.results[0]?.value;

      expect(returned.status).toBe("running");
      expect(returned.epoch).toBe(host.get("seat-resume")?.epoch);
      expect(returned.epoch).not.toBe(initiallyReturned?.epoch);
      expect(fake.controllers.length).toBeGreaterThanOrEqual(2);
      expect(fake.controllers[1]?.spec.args).not.toContain("--resume");
    } finally {
      if (priorHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
      else process.env.VELLUM_COMMAND_HOME = priorHome;
    }
  });
});

describe("Remote TerminalSeatProcess", () => {
  it("rejects an occupied lower-level occupy race and activates an exact actor", async () => {
    const live = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-1",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const createAgentSeat = vi.fn(async () => live);
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => live,
      createAgentSeat,
    });
    const occupy = vacantCommand("seat-r", "remote");

    const raced = await Effect.runPromiseExit(
      seats.occupy(occupy, actorSpec("seat-r", "station-a")),
    );
    expect(Exit.isFailure(raced)).toBe(true);

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
    expect(activated).toMatchObject({
      epoch: "epoch-1",
      hostId: "station-a",
    });
    expect(createAgentSeat).not.toHaveBeenCalled();
  });

  it("occupies a vacant actor seat once and projects the requested host", async () => {
    const created = remoteSummary({
      bindingId: "seat-r",
      epoch: "epoch-new",
      status: "running",
      harness: "grok",
      agentKey: "local:grok",
    });
    const createAgentSeat = vi.fn(
      async (_input: RemoteAgentSeatInput) => created,
    );
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => undefined,
      createAgentSeat,
    });

    const summary = await Effect.runPromise(
      seats.occupy(
        vacantCommand("seat-r", "remote"),
        actorSpec("seat-r", "station-a"),
      ),
    );
    expect(summary).toMatchObject({
      epoch: "epoch-new",
      hostId: "station-a",
      harness: "grok",
      agentKey: "local:grok",
    });
    expect(createAgentSeat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["starting geography", "starting", undefined, undefined],
    ["running geography", "running", undefined, undefined],
    ["same harness with a stale key", "running", "grok", "old:grok"],
  ] as const)(
    "adopts %s through explicit createAgentSeat",
    async (_name, status, harness, agentKey) => {
      let live = remoteSummary({
        bindingId: "seat-adopt",
        epoch: "epoch-adopt",
        status,
        ...(harness === undefined ? {} : { harness }),
        ...(agentKey === undefined ? {} : { agentKey }),
      });
      const createAgentSeat = vi.fn(
        async (input: RemoteAgentSeatInput) => {
          live = {
            ...live,
            harness: input.harness,
            agentKey: input.agentKey,
          };
          return live;
        },
      );
      const seats = makeRemoteSeatProcess("station-a", {
        get: async () => live,
        createAgentSeat,
      });
      const admission = seatAdmission(
        await Effect.runPromise(seats.occupancy("seat-adopt")),
      );
      if (admission._tag !== "ActivateOccupiedSeat") {
        throw new Error("expected activate");
      }

      const adopted = await Effect.runPromise(
        seats.activate(admission, {
          harness: "grok",
          agentKey: "local:grok",
        }),
      );

      expect(adopted).toMatchObject({
        bindingId: "seat-adopt",
        epoch: "epoch-adopt",
        hostId: "station-a",
        harness: "grok",
        agentKey: "local:grok",
      });
      expect(createAgentSeat).toHaveBeenCalledWith({
        bindingId: "seat-adopt",
        harness: "grok",
        agentKey: "local:grok",
      });
    },
  );

  it("refuses a different harness without asking the Remote to mutate", async () => {
    const live = remoteSummary({
      bindingId: "seat-mismatch",
      epoch: "epoch-mismatch",
      status: "running",
      harness: "claude",
      agentKey: "remote:claude",
    });
    const createAgentSeat = vi.fn(async () => live);
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => live,
      createAgentSeat,
    });
    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-mismatch")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }

    const mismatch = await Effect.runPromiseExit(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(createAgentSeat).not.toHaveBeenCalled();
  });

  it("rejects an adoption reply that changes epoch or actor identity", async () => {
    const geography = remoteSummary({
      bindingId: "seat-unverified",
      epoch: "epoch-original",
      status: "running",
    });
    const seats = makeRemoteSeatProcess("station-a", {
      get: async () => geography,
      createAgentSeat: async () =>
        remoteSummary({
          bindingId: "seat-unverified",
          epoch: "epoch-replaced",
          status: "running",
          harness: "grok",
          agentKey: "wrong:key",
        }),
    });
    const admission = seatAdmission(
      await Effect.runPromise(seats.occupancy("seat-unverified")),
    );
    if (admission._tag !== "ActivateOccupiedSeat") {
      throw new Error("expected activate");
    }

    const unverified = await Effect.runPromiseExit(
      seats.activate(admission, { harness: "grok", agentKey: "local:grok" }),
    );
    expect(Exit.isFailure(unverified)).toBe(true);
  });
});
