import { resolvedSpawnEnv } from "../adapters/exec";
import { termPlane, termPlaneBlocksAppExit } from "./plane";

/** The windowless shell starts the same local terminal plane as the window. */
export const startCoreSeats = async (options: { readonly home: string }) => {
  await resolvedSpawnEnv();
  await termPlane.start({ controlHome: options.home });
  let closeFlight: Promise<void> | undefined;
  return {
    beginShutdown: (reason = "core_quit"): void => termPlane.beginShutdown(reason),
    close: (reason = "core_quit"): Promise<void> => {
      closeFlight ??= termPlane.drainOnQuit(reason).then((receipt) => {
        if (termPlaneBlocksAppExit(receipt)) {
          throw new Error(`Seat processes did not stop: ${receipt.retainedLabels.join(", ")}`);
        }
      });
      return closeFlight;
    },
  };
};
