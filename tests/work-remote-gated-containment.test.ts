import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc, Part } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeSettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StateEngine } from "../src/main/junto/state/service";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/junto/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { WorkLive, WorkService } from "../src/main/junto/work/service";

const installationId = Schema.decodeUnknownSync(InstallationId);
const hostId = Schema.decodeUnknownSync(HostId);

const makeRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(
    join(root, "state", "junto.db"),
  );
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
  );
  return ManagedRuntime.make(workLive);
};

const taskNode = (
  id: string,
  homeHost?: string,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 220,
  height: 100,
  ether: {
    entity: { kind: "task" },
    ...(homeHost === undefined ? {} : { host: homeHost }),
  },
});

const rawMedia = (text: string): ReadonlyArray<Part> => [{
  kind: "raw",
  bytesBase64: Buffer.from(text).toString("base64"),
  mediaType: "image/png",
}];

const productPersistenceWitness = async (
  runtime: ReturnType<typeof makeRuntime>,
) => {
  const state = await runtime.runPromise(StateEngine);
  return runtime.runPromise(
    state.read("test remote gated containment witness", (reader) => {
      const count = (table: string): number =>
        Number(reader.get<{ value: number }>(
          `SELECT count(*) AS value FROM ${table}`,
        )?.value ?? 0);
      const totalChanges = Number(
        reader.get<{ value: number }>(
          "SELECT total_changes() AS value",
        )?.value ?? 0,
      );
      return {
        totalChanges,
        commands: count("work_commands"),
        events: count("work_events"),
        facts: count("work_facts"),
        tasks: count("work_tasks"),
        contentObjects: count("content_objects"),
        contentRefs: count("content_refs"),
      };
    }),
  );
};

const filesBelow = async (root: string): Promise<ReadonlyArray<string>> => {
  const visit = async (directory: string): Promise<ReadonlyArray<string>> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return [];
      }
      throw cause;
    }
    const paths = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? visit(path) : [relative(root, path)];
    }));
    return paths.flat().sort();
  };
  return visit(root);
};

describe("Remote-home approval Task containment", () => {
  it("refuses before content, command, event, fact, or Task persistence", async () => {
    const root = join(
      tmpdir(),
      `junto-remote-gated-${randomUUID()}`,
    );
    const runtime = makeRuntime(root);

    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }));

      const remoteHost = hostId("studio");
      const remoteInstallation = installationId("studio-installation");
      const fleetTargets = await runtime.runPromise(
        StationFleetTargetRepository,
      );
      await runtime.runPromise(fleetTargets.bind({
        hostId: remoteHost,
        stationInstallationId: remoteInstallation,
      }, "2026-08-26T00:00:00.000Z"));

      const canvasName = "remote-gated-containment";
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write(canvasName, {
        nodes: [
          taskNode("remote-tasks", remoteHost),
          taskNode("command-center-tasks"),
        ],
        edges: [],
      }));

      const work = await runtime.runPromise(WorkService);
      const repository = await runtime.runPromise(WorkRepository);
      const contentRoot = join(root, "content");
      const beforeRows = await productPersistenceWitness(runtime);
      const beforeFiles = await filesBelow(contentRoot);

      const planningResult = await runtime.runPromise(
        work.workTaskCreate(
          canvasName,
          "remote-tasks",
          "plan on the Remote",
          { details: "plan on the Remote" },
          undefined,
          rawMedia("planning-media-must-not-persist"),
          undefined,
          undefined,
          undefined,
          { admission: "approval" },
        ),
      );
      const gatedCreateResult = await runtime.runPromise(
        work.workTaskCreate(
          canvasName,
          "remote-tasks",
          "create an approval Task on the Remote",
          { details: "create an approval Task on the Remote" },
          undefined,
          rawMedia("create-media-must-not-persist"),
          undefined,
          undefined,
          undefined,
          { admission: "approval" },
        ),
      );

      for (const result of [planningResult, gatedCreateResult]) {
        expect(result).toEqual({
          ok: false,
          code: "wrong_home",
          message:
            "approval Task creation cannot target a Remote home because " +
            "Station protocol 1 cannot carry Task approval; move the Tasks node " +
            "to Command Center before creating the Task",
          details: {
            target: "remote-tasks",
            retryable: false,
            next_step:
              "move the Tasks node to Command Center before creating the Task",
          },
        });
      }

      expect(await productPersistenceWitness(runtime)).toEqual(beforeRows);
      expect(await filesBelow(contentRoot)).toEqual(beforeFiles);
      expect(await runtime.runPromise(repository.pendingCommands)).toEqual([]);
      expect(await runtime.runPromise(
        repository.snapshotsForCanvas(canvasName),
      )).toEqual([]);

      const projected = await runtime.runPromise(canvases.read(canvasName));
      expect(
        projected.doc.nodes.find((node) => node.id === "remote-tasks")
          ?.ether?.tasks?.items ?? [],
      ).toEqual([]);

      const localPlanning = await runtime.runPromise(
        work.workTaskCreate(
          canvasName,
          "command-center-tasks",
          "plan at Command Center",
          { details: "plan at Command Center" },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { admission: "approval" },
        ),
      );
      expect(localPlanning).toMatchObject({
        ok: true,
        disposition: "applied",
        data: { admission: "approval" },
      });
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
