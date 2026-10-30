import { expect, it } from "vitest";
import { coreOpBody } from "../src/main/core-process/ops";
import "../src/main/core-process/ops/index";

/**
 * A group committed without its line in ops/index.ts is not registered, and
 * its call sites answer UnknownCoreOp at runtime. This holds the groups the
 * window's ipc.ts calls by name to that line.
 */
it("every group ipc.ts calls is registered by ops/index", () => {
  const names = [
    "ipc.model.canvases",
    "ipc.model.open",
    "ipc.model.command",
    "ipc.model.actorRefs",
    "ipc.work.topology",
    "ipc.work.mailbox",
    "ipc.work.mentions",
    "ipc.work.item",
    "ipc.work.attention",
    "ipc.work.sinkPage",
    "ipc.work.mailPage",
    "ipc.work.seatRecentOps",
    "ipc.status.authority",
    "ipc.status.digest",
    "ipc.status.usageCurrent",
    "ipc.status.usageRefresh",
    "ipc.status.kernel",
  ];
  for (const name of names) expect(coreOpBody(name), name).toBeTypeOf("function");
});
