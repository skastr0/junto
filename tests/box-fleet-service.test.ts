import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

// Box unit tests exercise the service body; production freezes Box for the
// macOS-only release surface — open the gate for this suite only.
vi.mock("@shared/release-capabilities", () => ({
  RELEASE_CAPABILITIES: Object.freeze({
    freshRemoteEnrollment: true,
    managedRemoteDeploy: true,
    darwinRemoteDeploy: true,
    linuxRemoteDeploy: true,
    boxFleet: true,
    commandCenterTransfer: true,
  }),
  BOX_FLEET_DISABLED_DETAIL: "box fleet disabled (test mock)",
}));

import {
  BoxOwnershipRepositoryLive,
  type BoxMachineType,
} from "../src/main/vellum/box";
import { BoxCli } from "../src/main/vellum/box/cli";
import { BoxCliCommandError } from "../src/main/vellum/box/domain";
import {
  BoxOwnershipRepository,
  BoxOwnershipPersistenceError,
} from "../src/main/vellum/box/repository";
import { makeBoxFleetService } from "../src/main/vellum/box/service";
import { BoxFleetAuthorizationError } from "../src/main/vellum/box/service";
import { makeHostsRegistry } from "../src/main/vellum/hosts/registry";
import {
  findHostById,
  setHostsSnapshot,
} from "../src/main/vellum/hosts/snapshot";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

const machine = (
  state = "running",
  ip: string | null = "203.0.113.8",
): BoxMachineType => ({
  id: "bx_c79mgja6" as BoxMachineType["id"],
  name: "Vellum Command Box",
  ip,
  state,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: `2026-07-27T00:00:0${state === "running" ? "1" : "2"}.000Z`,
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-box-fleet-"));
  roots.push(root);
  const stateLive = makeStateEngineLive(join(root, "vellum-command.db"));
  const complete = ManagedRuntime.make(
    Layer.provideMerge(BoxOwnershipRepositoryLive, stateLive),
  );
  runtimes.push(complete);
  const repository = await complete.runPromise(BoxOwnershipRepository);
  const state = await complete.runPromise(StateEngine);
  return { repository, state };
};

afterEach(async () => {
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("Box Fleet service ownership", () => {
  it("returns a created Box only after SSH preparation and route verification", async () => {
    const { repository, state } = await fixture();
    const create = vi.fn(() => Effect.succeed(machine()));
    const cli = BoxCli.of({
      availability: Effect.succeed({
        available: true,
        authenticated: true,
        healthy: true,
        detail: "ready",
      }),
      create,
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);

    const resource = await Effect.runPromise(service.create());

    expect(resource).toMatchObject({
      machine: { id: "bx_c79mgja6", state: "running" },
      hostId: "box-c79mgja6",
    });
    const hosts = await makeHostsRegistry(state, (e) => Effect.runPromise(e)).list();
    expect(hosts.find((host) => host.id === resource.hostId)).toMatchObject({
      sshEndpoint: "user@203.0.113.8",
      sshIdentityFile: "/Users/operator/.ssh/ascii_box_ed25519",
      sshHostKeyPolicy: "accept-new",
      capabilities: ["terminal", "browser", "herdr", "hermes"],
    });
    expect(await Effect.runPromise(repository.list)).toHaveLength(1);
    expect(create).toHaveBeenCalledWith({
      autoStop: { kind: "ttl", ttlSeconds: 600 },
      includeAccountSecrets: undefined,
    });
  });

  it("keeps provider ownership visible when SSH preparation fails", async () => {
    const { repository, state } = await fixture();
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() =>
        Effect.fail(
          BoxCliCommandError.make({
            operation: "prepare-ssh",
            detail: "Box SSH key authorization failed",
          }),
        ),
      ),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);

    const result = await Effect.runPromise(Effect.result(service.create()));

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
      _tag: "BoxFleetProvisioningError",
      boxId: "bx_c79mgja6",
      stage: "prepare-ssh",
    });
    const [owned] = await Effect.runPromise(repository.list);
    expect(owned?.machine.id).toBe("bx_c79mgja6");
    expect(owned?.hostId).toBeUndefined();
    expect(await makeHostsRegistry(state, (e) => Effect.runPromise(e)).get("box-c79mgja6")).toBeUndefined();
  });

  it("returns the exact provider identity when local ownership enrollment fails", async () => {
    const { repository } = await fixture();
    const create = vi.fn(() => Effect.succeed(machine()));
    const cli = BoxCli.of({
      availability: Effect.never,
      create,
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const failingRepository = BoxOwnershipRepository.of({
      ...repository,
      enrollCreated: () =>
        Effect.fail(
          BoxOwnershipPersistenceError.make({
            operation: "enroll",
            detail: "local database unavailable",
            cause: new Error("write failed"),
          }),
        ),
    });
    const service = makeBoxFleetService(cli, failingRepository);

    const result = await Effect.runPromise(Effect.result(service.create()));

    expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
      _tag: "BoxFleetProvisioningError",
      boxId: "bx_c79mgja6",
      stage: "record-ownership",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps a stopped Box enrolled with its last OpenSSH route", async () => {
    const { repository, state } = await fixture();
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopping"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);
    await Effect.runPromise(service.create());

    const stopped = await Effect.runPromise(
      service.stop("bx_c79mgja6"),
    );

    // Stop must not unenroll — same Station, temporarily unreachable.
    expect(stopped.hostId).toBe("box-c79mgja6");
    expect(await makeHostsRegistry(state, (e) => Effect.runPromise(e)).get("box-c79mgja6")).toMatchObject({
      sshEndpoint: "user@203.0.113.8",
    });
    expect(await Effect.runPromise(repository.list)).toHaveLength(1);
  });

  it("detaches ownership and fleet host without touching the provider", async () => {
    const { repository, state } = await fixture();
    const stop = vi.fn(() => Effect.succeed(machine("stopped")));
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop,
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);
    await Effect.runPromise(service.create());

    await Effect.runPromise(service.detach("bx_c79mgja6"));

    expect(stop).not.toHaveBeenCalled();
    expect(await Effect.runPromise(repository.list)).toHaveLength(0);
    expect(await makeHostsRegistry(state, (e) => Effect.runPromise(e)).get("box-c79mgja6")).toBeUndefined();
  });

  it("converges the process-local route before a lifecycle call returns", async () => {
    const { repository, state } = await fixture();
    const registry = makeHostsRegistry(state, (e) => Effect.runPromise(e));
    const convergeHosts = Effect.promise(async () => {
      setHostsSnapshot(await registry.reload());
    });
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() =>
        Effect.succeed(machine("running", "203.0.113.99")),
      ),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(
      cli,
      repository,
      Effect.void,
      {
        identityFile: "/Users/operator/.ssh/ascii_box_ed25519",
        verify: () => Effect.void,
        convergeHosts,
      },
    );

    await Effect.runPromise(service.create());
    await Effect.runPromise(service.resume("bx_c79mgja6"));

    expect(findHostById("box-c79mgja6")?.sshEndpoint).toBe(
      "user@203.0.113.99",
    );
  });

  it("refuses lifecycle access to every Box absent from Vellum Command ownership state", async () => {
    const { repository } = await fixture();
    const stop = vi.fn(() => Effect.succeed(machine("stopped")));
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop,
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);

    const result = await Effect.runPromise(
      Effect.result(service.stop("bx_23456789")),
    );

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure._tag : "").toBe(
      "BoxOwnershipNotFoundError",
    );
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps Command Center authorization inside the Fleet capability", async () => {
    const { repository } = await fixture();
    const create = vi.fn(() => Effect.succeed(machine()));
    const cli = BoxCli.of({
      availability: Effect.never,
      create,
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(
      cli,
      repository,
      Effect.fail(
        BoxFleetAuthorizationError.make({
          detail: "Only Command Center may operate a Fleet Box",
        }),
      ),
    );

    const result = await Effect.runPromise(Effect.result(service.create()));

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure._tag : "").toBe(
      "BoxFleetAuthorizationError",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("refreshes the Fleet SSH route when an owned Box resumes at a new IP", async () => {
    const { repository, state } = await fixture();
    await Effect.runPromise(repository.enrollCreated(machine()));
    const resumed = machine("running", "203.0.113.99");
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(resumed)),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);

    await Effect.runPromise(service.resume("bx_c79mgja6"));

    expect(
      (await makeHostsRegistry(state, (e) => Effect.runPromise(e)).get("box-c79mgja6"))?.sshEndpoint,
    ).toBe("user@203.0.113.99");
  });

  it("maps canvas demand to an exact owned Box provider lease", async () => {
    const { repository } = await fixture();
    await Effect.runPromise(repository.enrollCreated(machine()));
    const setAutoStop = vi.fn((_box: unknown, _policy: unknown) => Effect.void);
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop,
    });
    const service = makeBoxFleetService(cli, repository);

    await Effect.runPromise(service.setActivityDemand("bx_c79mgja6", false));
    await Effect.runPromise(service.setActivityDemand("bx_c79mgja6", true));

    expect(setAutoStop.mock.calls.map(([, policy]) => policy)).toEqual([
      { kind: "ttl", ttlSeconds: 600 },
      { kind: "disabled" },
    ]);
  });

  it("refreshes provider truth and resumes a TTL-stopped Box on host interaction", async () => {
    const { repository, state } = await fixture();
    let providerMachine = machine();
    const resume = vi.fn(() => {
      providerMachine = machine("running", "203.0.113.99");
      return Effect.succeed(providerMachine);
    });
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(providerMachine)),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume,
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);
    await Effect.runPromise(service.create());
    providerMachine = machine("stopped");

    const restored = await Effect.runPromise(
      service.ensureHostAvailable("box-c79mgja6"),
    );

    expect(resume).toHaveBeenCalledTimes(1);
    expect(restored?.machine).toMatchObject({
      state: "running",
      ip: "203.0.113.99",
    });
    expect(
      (await makeHostsRegistry(state, (e) => Effect.runPromise(e)).get("box-c79mgja6"))?.sshEndpoint,
    ).toBe("user@203.0.113.99");
  });

  it("does not query Box for a host absent from Vellum Command ownership", async () => {
    const { repository } = await fixture();
    const info = vi.fn(() => Effect.succeed(machine()));
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info,
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      prepareSsh: vi.fn(() => Effect.void),
      setAutoStop: vi.fn(() => Effect.void),
    });
    const service = makeBoxFleetService(cli, repository);

    const result = await Effect.runPromise(
      service.ensureHostAvailable("other-host"),
    );

    expect(result).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });
});
