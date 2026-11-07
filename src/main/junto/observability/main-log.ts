/**
 * Electron main's one log. Its rows cross to the core's ring, where the panel
 * reads them and where `appendScrubbed` scrubs them again with the registry
 * only the core holds; main knows no secret values, so it hands its log none.
 *
 * A value, not a slot: it is built here, with the forwarder it uses, and every
 * main module that logs imports this instance.
 */
import { core } from "../../core-process/main-client";
import { createLogger } from "./logger";

export const mainLog = createLogger({
  process: "app",
  echo: true,
  sink: (entry) => {
    void core.call("observability.append", { entry }).catch(() => undefined);
  },
});
