/**
 * Side-effect-only demo isolation boundary. This must run before runtime.ts:
 * Demo mode admits VELLUM_STATE_DB as its isolated database override, while
 * VELLUM_CANVASES_DIR names only the derivative digest/SVG output root.
 *
 * Explicit overrides remain authoritative so hermetic launchers can provide
 * throwaway roots. Without them, a demo gets its own database and projection
 * outputs instead of touching the operator's product state.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { isDemoMode } from "./mode";

if (isDemoMode()) {
  const demoRoot = join(homedir(), ".vellum", "demo");
  if (!process.env.VELLUM_STATE_DB) {
    process.env.VELLUM_STATE_DB = join(demoRoot, "state", "vellum.db");
  }
  if (!process.env.VELLUM_CANVASES_DIR) {
    process.env.VELLUM_CANVASES_DIR = join(demoRoot, "projections");
  }
}
