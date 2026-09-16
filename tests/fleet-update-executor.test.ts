import { describe, expect, it } from "vitest";
import type { HostsDeployRemoteResult } from "../src/shared/ipc";
import {
  executorRemotesOf,
  FLEET_UPDATE_MAX_ATTEMPTS,
  makeFleetUpdateExecutor,
  type FleetExecutorRemote,
  type FleetUpdateExecutorDeps,
} from "../src/main/junto/update/fleet-executor";
import type { RemoteUpdateDeployJobFacts } from "../src/shared/remote-update-status";

const remote = (
  hostId: string,
  installedVersion: string | undefined = "0.1.0",
  platform: FleetExecutorRemote["platform"] = "darwin",
): FleetExecutorRemote => ({
  hostId,
  endpoint: `user@${hostId}`,
  platform,
  installedVersion,
});

const okResult: HostsDeployRemoteResult = {
  ok: true,
  detail: "Junto is on this Mac",
  outcome: "ready",
  version: "0.1.1",
  statusRecorded: true,
};

const waitingResult: HostsDeployRemoteResult = {
  ok: false,
  detail: "2 active terminal sessions on this Remote",
  code: "conflict",
  statusRecorded: true,
  recoveryAction: {
    kind: "close-active-junto-terminals",
    activeTerminalSessions: 2,
  },
};

const transientResult: HostsDeployRemoteResult = {
  ok: false,
  detail: "Can't reach this machine on the network.",
  code: "io",
};

type Recorded = Parameters<FleetUpdateExecutorDeps["recordRefusal"]>[0];

const makeHarness = (input: {
  readonly remotes: ReadonlyArray<FleetExecutorRemote>;
  readonly deploy: (
    hostId: string,
  ) => Promise<HostsDeployRemoteResult> | HostsDeployRemoteResult;
  readonly role?: string;
  readonly remoteManagedInstalls?: boolean;
  readonly releaseAllowed?: boolean;
  readonly commandCenterVersion?: string;
  readonly feedVersion?: string;
  readonly deployJob?: (
    hostId: string,
  ) => RemoteUpdateDeployJobFacts | undefined;
}) => {
  const deployCalls: string[] = [];
  const recorded: Recorded[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const executor = makeFleetUpdateExecutor({
    settings: () =>
      Promise.resolve({
        role: input.role ?? "command-center",
        remoteManagedInstalls: input.remoteManagedInstalls ?? true,
      }),
    updateFacts: () =>
      Promise.resolve({
        commandCenterVersion: input.commandCenterVersion ?? "0.1.1",
        ...(input.feedVersion === undefined
          ? {}
          : { feedVersion: input.feedVersion }),
      }),
    listRemotes: () => Promise.resolve(input.remotes),
    deployJob: input.deployJob ?? (() => undefined),
    deployRemote: async (hostId) => {
      deployCalls.push(hostId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a tick so overlap would be observable if it existed.
      await Promise.resolve();
      const result = await input.deploy(hostId);
      inFlight -= 1;
      return result;
    },
    releaseDeployAllowed: () => input.releaseAllowed ?? true,
    recordRefusal: (entry) => {
      recorded.push(entry);
      return Promise.resolve();
    },
  });
  return {
    executor,
    deployCalls,
    recorded,
    maxInFlight: () => maxInFlight,
  };
};

describe("fleet update executor", () => {
  it("walks eligible Remotes strictly one at a time", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a"), remote("mac-b"), remote("mac-c", "0.1.1")],
      deploy: () => okResult,
    });
    const summary = await harness.executor.runPass();
    expect(summary.ran).toBe(true);
    expect(summary.attempted).toEqual(["mac-a", "mac-b"]);
    expect(harness.deployCalls).toEqual(["mac-a", "mac-b"]);
    expect(harness.maxInFlight()).toBe(1);
    expect(harness.executor.states().get("mac-a")?.disposition).toBe(
      "succeeded",
    );
  });

  it("does nothing while the kill-switch is off", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => okResult,
      remoteManagedInstalls: false,
    });
    const summary = await harness.executor.runPass();
    expect(summary).toEqual({
      ran: false,
      reason: "managed-installs-off",
      attempted: [],
    });
    expect(harness.deployCalls).toEqual([]);
  });

  it("does nothing off the command-center role or behind the release gate", async () => {
    const asRemote = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => okResult,
      role: "remote",
    });
    expect((await asRemote.executor.runPass()).reason).toBe(
      "not-command-center",
    );
    const gated = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => okResult,
      releaseAllowed: false,
    });
    expect((await gated.executor.runPass()).reason).toBe(
      "release-gate-closed",
    );
    expect(asRemote.deployCalls).toEqual([]);
    expect(gated.deployCalls).toEqual([]);
  });

  it("waits while the feed is ahead of the running Command Center", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a", "0.1.0")],
      deploy: () => okResult,
      commandCenterVersion: "0.1.1",
      feedVersion: "0.2.0",
    });
    const summary = await harness.executor.runPass();
    expect(summary.ran).toBe(true);
    expect(harness.deployCalls).toEqual([]);
  });

  it("re-attempts a waiting-for-idle Remote on the next pass without spending retries", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => waitingResult,
    });
    await harness.executor.runPass();
    await harness.executor.runPass();
    await harness.executor.runPass();
    expect(harness.deployCalls).toEqual(["mac-a", "mac-a", "mac-a"]);
    const state = harness.executor.states().get("mac-a");
    expect(state?.disposition).toBe("waiting-for-idle");
    expect(state?.attempts).toBe(0);
    // The coordinator already persisted the refusal (statusRecorded true).
    expect(harness.recorded).toEqual([]);
  });

  it("bounds transient failures and records the terminal refusal durably", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => transientResult,
    });
    for (let pass = 0; pass < FLEET_UPDATE_MAX_ATTEMPTS + 2; pass += 1) {
      await harness.executor.runPass();
    }
    // Attempts stop at the bound; later passes skip the refused host.
    expect(harness.deployCalls).toHaveLength(FLEET_UPDATE_MAX_ATTEMPTS);
    const state = harness.executor.states().get("mac-a");
    expect(state?.disposition).toBe("refused");
    expect(state?.attempts).toBe(FLEET_UPDATE_MAX_ATTEMPTS);
    // Every unpersisted attempt left a durable receipt; the last one names
    // the stop.
    expect(harness.recorded).toHaveLength(FLEET_UPDATE_MAX_ATTEMPTS);
    const last = harness.recorded[harness.recorded.length - 1];
    expect(last?.detail).toContain("Managed update stopped for 0.1.1");
    expect(last?.hostId).toBe("mac-a");
    expect(last?.endpoint).toBe("user@mac-a");
    expect(last?.targetVersion).toBe("0.1.1");
  });

  it("treats a validation refusal as permanent immediately", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => ({
        ok: false,
        detail: "Managed Remote package deployment is disabled in this release.",
        code: "validation",
      }),
    });
    await harness.executor.runPass();
    await harness.executor.runPass();
    expect(harness.deployCalls).toEqual(["mac-a"]);
    expect(harness.executor.states().get("mac-a")?.disposition).toBe(
      "refused",
    );
  });

  it("resets the walk state when the target release changes", async () => {
    let version = "0.1.1";
    const harness = makeHarness({
      remotes: [remote("mac-a")],
      deploy: () => ({ ...transientResult, code: "validation" }),
      get commandCenterVersion() {
        return version;
      },
    });
    await harness.executor.runPass();
    expect(harness.executor.states().get("mac-a")?.disposition).toBe(
      "refused",
    );
    version = "0.1.2";
    await harness.executor.runPass();
    expect(harness.deployCalls).toEqual(["mac-a", "mac-a"]);
    expect(harness.executor.states().get("mac-a")?.targetVersion).toBe(
      "0.1.2",
    );
  });

  it("never double-attempts a host with a live deploy in flight", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a"), remote("mac-b")],
      deploy: () => okResult,
      deployJob: (hostId) =>
        hostId === "mac-a"
          ? { status: "running", stages: ["configure remote"] }
          : undefined,
    });
    const summary = await harness.executor.runPass();
    expect(summary.attempted).toEqual(["mac-b"]);
    expect(harness.deployCalls).toEqual(["mac-b"]);
  });

  it("skips a Remote that already succeeded for this release even if observation lags", async () => {
    const harness = makeHarness({
      remotes: [remote("mac-a", "0.1.0")],
      deploy: () => okResult,
    });
    await harness.executor.runPass();
    // Probe still reports the old version; the walk must not redeploy.
    await harness.executor.runPass();
    expect(harness.deployCalls).toEqual(["mac-a"]);
  });

  it("keeps Linux Remotes observed but off the auto-walk", async () => {
    const harness = makeHarness({
      remotes: [remote("box-1", "0.1.0", "linux"), remote("mac-a", "0.1.0")],
      deploy: () => okResult,
    });
    const summary = await harness.executor.runPass();
    expect(summary.attempted).toEqual(["mac-a"]);
  });
});

describe("executorRemotesOf", () => {
  it("projects enrolled Remotes with the Box platform heuristic and observed versions", () => {
    const remotes = executorRemotesOf(
      [
        { id: "mac-a", kind: "remote", sshEndpoint: "user@mac-a" },
        { id: "box-1", kind: "remote", sshEndpoint: "user@box-1" },
        // Filtered: not a Remote, and a Remote without an endpoint.
        { id: "local", kind: "local" },
        { id: "mac-b", kind: "remote" },
      ],
      new Map([["mac-a", "0.1.0"]]),
    );

    expect(remotes).toEqual([
      {
        hostId: "mac-a",
        endpoint: "user@mac-a",
        platform: "darwin",
        installedVersion: "0.1.0",
      },
      {
        hostId: "box-1",
        endpoint: "user@box-1",
        platform: "linux",
        installedVersion: undefined,
      },
    ]);
  });
});
