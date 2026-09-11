import { describe, expect, it } from "vitest";
import type { TextNode } from "../src/shared/canvas";
import type { OverseerCaller } from "../src/shared/overseer-control";
import type { InstallationId } from "../src/shared/station-api";
import {
  createGrantSourceStore,
  lateBoundDrive,
  reseatCanvasArgs,
  schedulerCanvasArgs,
} from "../src/main/vellum-command/overseer/composition";

const origin: OverseerCaller = { canvasName: "command", nodeId: "overseer-seat" };
const targetCanvas = "factory";
const targetAgent = "worker-1";
const targetScheduler = "cron-1";

const nextAgent: TextNode = {
  id: targetAgent,
  type: "text",
  text: "worker",
  x: 0,
  y: 0,
  width: 220,
  height: 84,
  ether: {
    entity: { kind: "agent", name: "local:amp" },
    terminal: { bindingId: "bind-1", harness: "amp" },
  },
};

describe("overseer composition origin vs target", () => {
  it("passes origin caller and target canvas into commitAgentReseat", () => {
    const mapped = reseatCanvasArgs({
      caller: origin,
      canvasName: targetCanvas,
      nodeId: targetAgent,
      next: nextAgent,
    });
    expect("ok" in mapped).toBe(false);
    if ("ok" in mapped) return;
    expect(mapped.caller).toEqual(origin);
    expect(mapped.caller.nodeId).not.toBe(targetAgent);
    expect(mapped.args).toMatchObject({
      canvas: targetCanvas,
      nodeId: targetAgent,
      harness: "amp",
    });
    expect(mapped.next).toBe(nextAgent);
  });

  it("passes origin caller and target canvas into applySchedulerConfigure", () => {
    const mapped = schedulerCanvasArgs({
      caller: origin,
      canvasName: targetCanvas,
      nodeId: targetScheduler,
      timer: { kind: "cron", expression: "0 * * * *" },
    });
    expect(mapped.caller).toEqual(origin);
    expect(mapped.caller.nodeId).not.toBe(targetScheduler);
    expect(mapped.args.canvas).toBe(targetCanvas);
    expect(mapped.args.nodeId).toBe(targetScheduler);
    expect(mapped.args.timer).toEqual({ kind: "cron", expression: "0 * * * *" });
  });
});

describe("overseer composition grant source isolation", () => {
  it("keeps concurrent local and Remote sources from crossing", async () => {
    const local = "local-install" as InstallationId;
    const remote = "remote-install" as InstallationId;
    const store = createGrantSourceStore(local);
    const seen: string[] = [];

    const left = store.runWithSource(local, async () => {
      await Promise.resolve();
      seen.push(`left:${String(store.liveSource())}`);
    });
    const right = store.runWithSource(remote, async () => {
      await Promise.resolve();
      seen.push(`right:${String(store.liveSource())}`);
    });
    await Promise.all([left, right]);
    expect(seen).toContain("left:local-install");
    expect(seen).toContain("right:remote-install");
    expect(store.liveSource()).toBe(local);
  });
});

describe("overseer composition absence", () => {
  it("returns false from writePrompt when the managed drive is unbound", async () => {
    const drive = lateBoundDrive();
    await expect(drive.writePrompt("binding", "hello")).resolves.toBe(false);
    await expect(drive.interrupt("binding")).resolves.toBe(false);
  });
});
