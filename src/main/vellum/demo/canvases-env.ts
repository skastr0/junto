/**
 * Side-effect-only module: in demo mode, defaults VELLUM_CANVASES_DIR to a
 * dedicated demo-canvases directory BEFORE canvases.ts (or anything that
 * imports it) ever reads process.env.VELLUM_CANVASES_DIR, so demo takes
 * never touch the operator's real ~/.vellum/canvases. Import this first
 * (before any other local import) in src/main/index.ts. Flag-gated and a
 * no-op outside demo mode; never overrides an operator-set value.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { isDemoMode } from "./mode";

if (isDemoMode() && !process.env.VELLUM_CANVASES_DIR) {
  process.env.VELLUM_CANVASES_DIR = join(homedir(), ".vellum", "demo-canvases");
}
