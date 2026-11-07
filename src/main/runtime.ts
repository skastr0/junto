import { app } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mainLog } from "./junto/observability/main-log";
import productMetadata from "../../package.json";
import {
  macArm64UpdateFeed,
  linuxX64UpdateFeed,
  makePlatformUpdateProvider,
  makeUpdateServiceLayer,
  type UpdateProvider,
} from "./junto/update";

/**
 * The one update provider this main process offers: the service checks and
 * stages through it, and the install IPC finalizes through the same object.
 * Made once, here, from what only Electron's app knows.
 */
export const updateProvider: UpdateProvider = makePlatformUpdateProvider({
  platform: process.platform,
  isPackaged: app.isPackaged,
  currentVersion: app.getVersion() || productMetadata.version,
});

// UpdateService joins this ManagedRuntime — never a second runtime.
const UpdateServiceLive = Layer.unwrap(
  Effect.sync(() => {
    const provider = updateProvider;
    const packaged = app.isPackaged;
    return makeUpdateServiceLayer({
      currentVersion: app.getVersion() || productMetadata.version,
      provider,
      install: {
        packaged,
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron ?? "unknown",
        providerKind: provider.kind,
        ...(packaged && provider.kind === "mac"
          ? { feedUrl: macArm64UpdateFeed().url }
          : packaged && provider.kind === "linux"
            ? { feedUrl: linuxX64UpdateFeed().url }
            : {}),
      },
    });
  }),
);

// The product owns one warm runtime in this process and disposes it on
// shutdown. The core runs in its own process, so main builds no core: only
// what is Electron's. The layer's type is exactly that, so an effect asking
// main for a core service is a compile error here, never a second copy of a
// singleton that main leaves empty.
const AppLayer = mainLog.withLogger(Layer.mergeAll(UpdateServiceLive));
export const AppRuntime = ManagedRuntime.make(AppLayer);
