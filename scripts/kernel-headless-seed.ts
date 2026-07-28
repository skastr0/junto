import { isAbsolute } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  KernelStateRepository,
  KernelStateRepositoryLive,
} from "../src/main/vellum/kernel/repository";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  StationRepository,
  StationRepositoryLive,
} from "../src/main/vellum/station/repository";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";
import {
  KERNEL_PROBE_CANVAS,
  KERNEL_PROBE_COMMAND_CENTER_TOPOLOGY,
  KERNEL_PROBE_REGION_ID,
  makeKernelHeadlessFixture,
} from "./kernel-headless-fixture";

const [stateDatabase, armedInput] = process.argv.slice(2);

if (
  stateDatabase === undefined ||
  !isAbsolute(stateDatabase) ||
  (armedInput !== "armed" && armedInput !== "disarmed")
) {
  throw new Error(
    "usage: kernel-headless-seed <absolute-state-database> <armed|disarmed>",
  );
}

const stateLayer = makeStateEngineLive(stateDatabase);
const repositories = Layer.provideMerge(
  Layer.mergeAll(
    WorkRepositoryLive,
    KernelStateRepositoryLive,
    SettingsLive,
    StationRepositoryLive,
  ),
  stateLayer,
);
const seedServices = Layer.provideMerge(CanvasesLive, repositories);
const runtime = ManagedRuntime.make(seedServices);

try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const kernelState = yield* KernelStateRepository;
      const settings = yield* SettingsService;
      const stations = yield* StationRepository;

      // Actor-seat compilation resolves HostId through durable topology. Mint
      // this isolated installation first, then bind its authorial host through
      // the same Command Center settings operation used by the product.
      yield* stations.installationId;
      yield* settings.setStationTopology(
        KERNEL_PROBE_COMMAND_CENTER_TOPOLOGY,
      );
      yield* canvases.write(
        KERNEL_PROBE_CANVAS,
        makeKernelHeadlessFixture(),
      );
      yield* kernelState.setRegionArmed(
        KERNEL_PROBE_CANVAS,
        KERNEL_PROBE_REGION_ID,
        armedInput === "armed",
      );
    }),
  );
} finally {
  // Closing this runtime closes the only seeding connection. The probe refuses
  // to launch the app until this process has exited successfully.
  await runtime.dispose();
}

process.stdout.write("kernel-headless-seed: SQLITE SEEDED\n");
