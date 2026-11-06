/**
 * A unit test runs the core and main in one process, with no port between
 * them. The core's two outbound ends are joined straight to main's: what the
 * core publishes reaches main's subscribers (as the port relay does in the
 * app, `main-side/window-pushes.ts`), and what the core asks of the host runs
 * main's registered body (as main's port answers it, `host.ts`). A test's
 * PTYs run in the test process, as a windowless core's do.
 */
import { sendPushesTo } from "../src/main/core-process/push";
import { deliverPush } from "../src/main/core-process/main-side/core-pushes";
import { useHostClient } from "../src/main/core-process/core-host";
import { HostCallError } from "../src/main/core-process/host-ops";
import { runHostOp } from "../src/main/core-process/main-side/host-op-bodies";
import { placeTerminals } from "../src/main/terminal-process/use";

sendPushesTo(deliverPush);
useHostClient({
  call: async (name, input) => {
    const answer = await runHostOp(name, input);
    if (answer.ok) return answer.value as never;
    throw new HostCallError(name, answer.failure.tag, answer.failure.message);
  },
});
placeTerminals({ kind: "here" });
