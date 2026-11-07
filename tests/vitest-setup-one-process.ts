/**
 * A unit test runs the core and main in one process, with no port between
 * them. The core's two outbound ends are joined straight to main's: what the
 * core publishes reaches main's subscribers (as the port relay does in the
 * app, `main-side/window-pushes.ts`), and what the core asks of the host runs
 * main's registered body (as main's port answers it, `host.ts`). A test's
 * PTYs run in the test process, as a windowless core's do. A test that logs
 * builds the log it exercises (`support/test-log.ts`); this setup installs no
 * sink, no secret source and no terminal place.
 */
import { beforeAll } from "vitest";
import { sendPushesTo } from "../src/core/push";
import { deliverPush } from "../src/app/core-process/main-side/core-pushes";
import { useHostClient } from "../src/core/core-host";
import { HostCallError } from "../src/core/host-ops";
import { runHostOp } from "../src/app/core-process/main-side/host-op-bodies";
import { placeTerminals } from "../src/node/terminals/use";

sendPushesTo(deliverPush);
useHostClient({
  call: async (name, input) => {
    const answer = await runHostOp(name, input);
    if (answer.ok) return answer.value as never;
    throw new HostCallError(name, answer.failure.tag, answer.failure.message);
  },
});
placeTerminals({ kind: "here" });
// The reads load the core's shell and process seam, so install them after the
// test file has registered its mocks, never at setup load: a file that mocks
// app-process-plane's dependencies must see its mocks, not the real graph.
beforeAll(async () => {
  const { installInProcessCoreReads } = await import(
    "../src/core/in-process-reads"
  );
  installInProcessCoreReads();
});
