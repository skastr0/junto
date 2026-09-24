/**
 * proto-harness.ts — real Command Center services over a temp root for the
 * protocol scenarios (tests/pty-e2e/scenarios/paused-seat-report.test.ts).
 *
 *   CanvasesService (SQLite via StateEngine), WorkService, WorkRepository,
 *   PausePlane, SettingsService — the same layers the app composes.
 *
 * Fakes: a temp directory is the persistence root. Nothing else is faked.
 */
import { CrewRepositoryLive } from "../../src/main/junto/work/crew-repository";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { CanvasesLive, CanvasesService } from "../../src/main/junto/canvases";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/junto/work/repository";
import { WorkLive, WorkService } from "../../src/main/junto/work/service";
import { StationRepositoryLive } from "../../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../../src/main/junto/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../../src/main/junto/station/session-registry";
import { SettingsLive, SettingsService } from "../../src/main/junto/settings/service";
import { makeContentServiceLive } from "../../src/main/junto/content/service";
import { makeInstallOpsLive } from "../../src/main/junto/install-ops/engine";
import {
  FactoryPauseRepositoryLive,
} from "../../src/main/junto/pause/repository";
import { PausePlane, PausePlaneLive } from "../../src/main/junto/pause-plane";

export const makeProtoRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(join(root, "state", "junto.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      FactoryPauseRepositoryLive,
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
  const pauseLive = Layer.provideMerge(PausePlaneLive, repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, pauseLive));
};

export type ProtoHarnessOptions = {
  readonly root: string;
};

export class ProtoHarness {
  readonly root: string;
  readonly runtime: ReturnType<typeof makeProtoRuntime>;
  readonly canvases!: Context.Service.Shape<typeof CanvasesService>;
  readonly work!: Context.Service.Shape<typeof WorkService>;
  readonly repository!: Context.Service.Shape<typeof WorkRepository>;
  readonly pause!: Context.Service.Shape<typeof PausePlane>;
  readonly settings!: Context.Service.Shape<typeof SettingsService>;

  private disposed = false;

  constructor(options: ProtoHarnessOptions) {
    this.root = options.root;
    this.runtime = makeProtoRuntime(options.root);
  }

  /** Initialize the service handles (must run before any use). */
  async start(): Promise<void> {
    const [canvases, work, repository, pause, settings] = await Promise.all([
      this.runtime.runPromise(CanvasesService),
      this.runtime.runPromise(WorkService),
      this.runtime.runPromise(WorkRepository),
      this.runtime.runPromise(PausePlane),
      this.runtime.runPromise(SettingsService),
    ]);
    (this as { canvases: unknown }).canvases = canvases;
    (this as { work: unknown }).work = work;
    (this as { repository: unknown }).repository = repository;
    (this as { pause: unknown }).pause = pause;
    (this as { settings: unknown }).settings = settings;
    await this.runtime.runPromise(this.pause.start);
    this.canvases.start();
  }

  async setStationCommandCenter(): Promise<void> {
    await this.runtime.runPromise(
      this.settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
  }

  async writeDoc(name: string, doc: CanvasDoc): Promise<void> {
    await this.runtime.runPromise(this.canvases.write(name, doc));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.runtime.dispose();
    await rm(this.root, { recursive: true, force: true });
  }
}
