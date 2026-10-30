import { AppRuntime } from "../runtime";
import { inProcessCore, type CoreClient } from "./client";
import "./ops/index";

/**
 * Main's one handle on the core (Wave 3). Call sites in `index.ts`,
 * `junto/ipc.ts` and `term/ipc.ts` move from `AppRuntime.run*` to
 * `core.call(name, input)`, with each operation's body in a group under
 * `./ops`. Until every site has moved, the core runs in main's runtime; then
 * this handle becomes the port to the core process and the sites stay as
 * they are.
 */
export const core: CoreClient = inProcessCore(AppRuntime);
