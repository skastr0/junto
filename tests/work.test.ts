import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";

const installationId = Schema.decodeUnknownSync(InstallationId);
const remoteHostId = Schema.decodeUnknownSync(HostId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);

/**
 * The shared test database holds many canvases, so every seat carries a
 * binding unique to its canvas or its descriptor would conflict with a
 * same-named seat elsewhere.
 */
const agentNode = (
  id: string,
  canvasName: string,
  hostId = "local",
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "profile-13",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${id}` },
    terminal: {
      bindingId: `binding-${id}-${canvasName}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});

const mail = (messageId: string, text: string, role: Message["role"] = "user"): Message => ({
  messageId,
  role,
  parts: [{ kind: "text", text }],
});

const mockCanvasesHome = join(tmpdir(), `junto-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/junto/canvases";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  StationRepository,
  StationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/junto/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/junto/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/junto/station/session-registry";
import {
  makeSettingsLive,
  SettingsService,
} from "../src/main/junto/settings/service";
import {
  compileStationPortfolioBody,
} from "../src/main/junto/station/portfolio";
import {
  makeContentServiceLive,
} from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";

const makeWorkRuntime = (databasePath: string) => {
  const installRoot = join(databasePath, "..");
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      // Blank-slate station for Remote offline fixtures; tests configure role.
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(installRoot, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(installRoot, "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(
    CanvasesLive,
    repositoriesLive
  );
  return ManagedRuntime.make(((
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive) as never) as never)
    )
  );
};

const workRuntime = makeWorkRuntime(
  join(mockCanvasesHome, "state", "junto.db")
);
let work: Context.Service.Shape<typeof WorkService>;
let canvases: Context.Service.Shape<typeof CanvasesService>;
let repository: Context.Service.Shape<typeof WorkRepository>;

beforeAll(async () => {
  const settings = await workRuntime.runPromise(SettingsService);
  await workRuntime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    })
  );
  work = await workRuntime.runPromise(WorkService);
  canvases = await workRuntime.runPromise(CanvasesService);
  repository = await workRuntime.runPromise(WorkRepository);
});

afterAll(async () => {
  await workRuntime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

const actorOf = async (name: string, nodeId: string) => {
  const read = await workRuntime.runPromise(canvases.read(name));
  const actor = read.actorRefs.find((candidate) => candidate.nodeId === nodeId);
  if (actor === undefined) throw new Error(`missing actor ref for ${nodeId}`);
  return actor;
};

describe("WorkService — mail", () => {
  it("persists inbox mail without an authorial generation", async () => {
    const name = "work-mail-lane";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [agentNode("sender", name), agentNode("recipient", name)],
        edges: [
          {
            id: "edge-message",
            fromNode: "sender",
            toNode: "recipient",
            ether: { verb: "messages" },
          },
        ],
      })
    );
    const sender = await actorOf(name, "sender");
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));

    const appended = await workRuntime.runPromise(
      work.workMessageAppend(name, "recipient", null, mail("inbox-lane-1", "start"), sender)
    );
    if (!appended.ok) {
      throw new Error(`${appended.code}: ${appended.message}`);
    }

    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name)
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items
    ).toEqual([expect.objectContaining({ messageId: "inbox-lane-1" })]);
    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
  });

  it("binds a mailbox ack once, and only to mail that exists", async () => {
    const name = "work-mail-react";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [agentNode("sender", name), agentNode("owner", name)],
        edges: [
          {
            id: "edge-mail",
            fromNode: "sender",
            toNode: "owner",
            ether: { verb: "messages" },
          },
        ],
      })
    );
    const sender = await actorOf(name, "sender");
    const owner = await actorOf(name, "owner");
    const delivered = await workRuntime.runPromise(
      work.workMessageAppend(name, "owner", null, mail("mailbox-note-1", "ping"), sender)
    );
    expect(delivered.ok).toBe(true);

    const reacted = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-1", "ack", owner)
    );
    expect(reacted.ok).toBe(true);
    if (!reacted.ok) return;
    expect(reacted.data.messageId).toBe("mailbox-note-1");
    expect(reacted.data.reaction).toBe("ack");
    // The receipt is durable: re-reacting reads the first one back.
    const again = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-1", "ack", owner)
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.reactedAt).toBe(reacted.data.reactedAt);
    // A reaction binds to a message that exists — nothing else.
    const missing = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-2", "ack", owner)
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("not found in mailbox");
  });

  it("refuses mail from a seat homed on another installation", async () => {
    const name = "work-cross-home-actor";
    const remoteHost = remoteHostId("remote-actor");
    const remoteInstallation = installationId("remote-actor-installation");
    const fleetTargets = await workRuntime.runPromise(
      StationFleetTargetRepository
    );
    await workRuntime.runPromise(
      fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteInstallation,
        },
        "2026-07-28T00:00:00.000Z"
      )
    );
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          agentNode("remote-sender", name, remoteHost),
          agentNode("recipient", name),
        ],
        edges: [
          {
            id: "message",
            fromNode: "remote-sender",
            toNode: "recipient",
            ether: { verb: "messages" },
          },
        ],
      })
    );
    const remoteActor = await actorOf(name, "remote-sender");

    const result = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "recipient",
        null,
        mail("cross-home-message", "forged locally", "agent"),
        remoteActor
      )
    );
    expect(result).toMatchObject({ ok: false, code: "wrong_home" });
    if (!result.ok) {
      expect(result.message).toContain(
        "must originate on the installation that owns actor"
      );
    }
    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name)
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items ?? []
    ).toEqual([]);
  });

  it("lets a Remote-local seat queue mail for the Command Center while offline", async () => {
    const isolatedRoot = join(
      tmpdir(),
      `junto-work-remote-mail-${randomUUID()}`
    );
    const runtime = makeWorkRuntime(
      join(isolatedRoot, "state", "junto.db")
    );
    const commandCenter = installationId("command-center-mail");
    const hostId = stationHostId("studio");

    try {
      const station = await runtime.runPromise(StationRepository);
      const local = await runtime.runPromise(station.installationId);
      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenter,
            stationInstallationId: local,
            stationLabel: "Studio",
            appVersion: "test",
          })
        )
      );
      await runtime.runPromise(
        station.configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: local,
            configuration: {
              role: "remote",
              hostId,
              agentHostId: hostId,
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            },
            host: {
              id: hostId,
              label: "Studio",
              kind: "remote",
              capabilities: ["terminal"],
            },
          })
        )
      );

      const canvasName = "remote-mail";
      const body = compileStationPortfolioBody(
        new Map([
          [
            canvasName,
            {
              nodes: [
                agentNode("sender", canvasName, hostId),
                agentNode("recipient", canvasName, hostId),
              ],
              edges: [
                {
                  id: "mail",
                  fromNode: "sender",
                  toNode: "recipient",
                  ether: { verb: "messages" },
                },
              ],
            } satisfies CanvasDoc,
          ],
        ]),
        new Map([[hostId, local]])
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: logicalSequence("1"),
              sourceCanvasGeneration: logicalSequence("1"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote work source"),
              body,
              contentSha256: stationProjectionContentSha256(body),
              createdAt: "2026-07-27T12:00:00.000Z",
            },
          })
        )
      );

      const remoteCanvases = await runtime.runPromise(CanvasesService);
      const read = await runtime.runPromise(remoteCanvases.read(canvasName));
      const sender = read.actorRefs.find(
        (candidate) => candidate.nodeId === "sender"
      );
      if (sender === undefined) throw new Error("missing Remote sender actor");
      const remoteWork = await runtime.runPromise(WorkService);
      const remoteRepository = await runtime.runPromise(WorkRepository);

      const appended = await runtime.runPromise(
        remoteWork.workMessageAppend(
          canvasName,
          "recipient",
          null,
          mail("remote-mail-1", "from the station"),
          sender
        )
      );
      expect(appended).toMatchObject({
        ok: true,
        disposition: "queued",
      });

      const pending = await runtime.runPromise(
        remoteRepository.pendingCommands
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        resolution: undefined,
        command: {
          operation: "message.append",
          id: {
            route: {
              eventHome: local,
              entityHome: commandCenter,
            },
          },
          item: {
            kind: "message",
            itemId: "remote-mail-1",
            sink: { canvasName, nodeId: "recipient" },
          },
          body: {
            operation: "message.append",
            sentBy: sender,
          },
        },
      });
    } finally {
      await runtime.dispose();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
