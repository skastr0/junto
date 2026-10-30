import { app } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { withMachineLogger } from "./junto/observability";
import productMetadata from "../../package.json";
import {
  deferredUpdateHostHooks,
  installUpdateProviderHandle,
  macArm64UpdateFeed,
  linuxX64UpdateFeed,
  makePlatformUpdateProvider,
  makeUpdateServiceLayer,
} from "./junto/update";

// UpdateService joins this ManagedRuntime — never a second runtime.
// Host quiesce/relaunch hooks are late-bound from main/index after boot.
const UpdateServiceLive = Layer.unwrap(
  Effect.sync(() => {
    const provider = makePlatformUpdateProvider({
      platform: process.platform,
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion() || productMetadata.version,
    });
    installUpdateProviderHandle(provider);
    const packaged = app.isPackaged;
    return makeUpdateServiceLayer({
      currentVersion: app.getVersion() || productMetadata.version,
      provider,
      host: deferredUpdateHostHooks(),
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
const AppLayer = withMachineLogger(Layer.mergeAll(UpdateServiceLive));
export const AppRuntime = ManagedRuntime.make(AppLayer);
