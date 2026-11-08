/**
 * A unit test runs the core and main in one process, with no port between
 * them: a test that listens for a core push provides `inProcessPushes`
 * (`support/in-process-pushes.ts`), which reaches main's subscribers as the
 * port relay does in the app (`main-side/window-pushes.ts`). What the core asks of the
 * host, and what main asks of the core, are RPC groups a test builds on its
 * own links (`support/host-link.ts`, `support/core-clients.ts`). A test's
 * PTYs run in the test process, as a windowless core's do. A test that logs
 * builds the log it exercises (`support/test-log.ts`); this setup installs no
 * sink, no secret source and no terminal place.
 */
import { beforeAll } from "vitest";
import { placeTerminals } from "../src/node/terminals/use";

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
