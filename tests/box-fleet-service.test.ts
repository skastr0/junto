import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoxOwnershipRepositoryLive,
  type BoxMachineType,
} from "../src/main/vellum/box";
import { BoxCli } from "../src/main/vellum/box/cli";
import {
  BoxOwnershipRepository,
} from "../src/main/vellum/box/repository";
import { makeBoxFleetService } from "../src/main/vellum/box/service";
import { BoxFleetAuthorizationError } from "../src/main/vellum/box/service";
import { makeHostsRegistry } from "../src/main/vellum/hosts/registry";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

const machine = (
  state = "running",
  ip: string | null = "203.0.113.8",
): BoxMachineType => ({
  id: "bx_c79mgja6" as BoxMachineType["id"],
  name: "Vellum Box",
  ip,
  state,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: `2026-07-27T00:00:0${state === "running" ? "1" : "2"}.000Z`,
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-box-fleet-"));
  roots.push(root);
  const stateLive = makeStateEngineLive(join(root, "vellum.db"));
  const complete = ManagedRuntime.make(
    Layer.provideMerge(BoxOwnershipRepositoryLive, stateLive),
  );
  runtimes.push(complete);
  const repository = await complete.runPromise(BoxOwnershipRepository);
  const state = await complete.runPromise(StateEngine);
  return { repository, state };
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("Box Fleet service ownership", () => {
  it("atomically records a created Box and its Fleet host before returning it", async () => {
    const { repository, state } = await fixture();
    const cli = BoxCli.of({
      availability: Effect.succeed({
        available: true,
        authenticated: true,
        healthy: true,
        detail: "ready",
      }),
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop: vi.fn(() => Effect.succeed(machine("stopped"))),
      resume: vi.fn(() => Effect.succeed(machine())),
      ssh: vi.fn(() => Effect.succeed("")),
    });
    const service = makeBoxFleetService(cli, repository);

    const resource = await Effect.runPromise(service.create());

    expect(resource).toMatchObject({
      machine: { id: "bx_c79mgja6", state: "running" },
      hostId: "box-c79mgja6",
    });
    const hosts = await makeHostsRegistry(state).list();
    expect(hosts.find((host) => host.id === resource.hostId)).toMatchObject({
      sshEndpoint: "user@203.0.113.8",
      capabilities: ["terminal", "browser", "herdr", "hermes"],
    });
    expect(await Effect.runPromise(repository.list)).toHaveLength(1);
  });

  it("refuses lifecycle access to every Box absent from Vellum ownership state", async () => {
    const { repository } = await fixture();
    const stop = vi.fn(() => Effect.succeed(machine("stopped")));
    const cli = BoxCli.of({
      availability: Effect.never,
      create: vi.fn(() => Effect.succeed(machine())),
      info: vi.fn(() => Effect.succeed(machine())),
      stop,
      resume: vi.fn(() => Effect.succeed(machine())),
      ssh: vi.fn(() => Effect.succeed("")),
    });
    const service = makeBoxFleetService(cli, repository);

    const result = await Effect.runPromise(
      Effect.either(service.stop("bx_23456789")),
    );

    expect(result._tag).toBe("Left");
    expect(result._tag === "Left" ? result.left._tag : "").toBe(
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
      ssh: vi.fn(() => Effect.succeed("")),
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

    const result = await Effect.runPromise(Effect.either(service.create()));

    expect(result._tag).toBe("Left");
    expect(result._tag === "Left" ? result.left._tag : "").toBe(
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
      ssh: vi.fn(() => Effect.succeed("")),
    });
    const service = makeBoxFleetService(cli, repository);

    await Effect.runPromise(service.resume("bx_c79mgja6"));

    expect(
      (await makeHostsRegistry(state).get("box-c79mgja6"))?.sshEndpoint,
    ).toBe("user@203.0.113.99");
  });
});
