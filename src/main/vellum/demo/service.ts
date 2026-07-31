/**
 * Demo registry: one ScriptedMirrorTransport per host id, plus the two IPC
 * mutation endpoints (applyDemoCommand / writeDemoEdl) the renderer-side
 * conductor drives. Only reachable outside demo mode via the ipc.ts gate —
 * this module has no flag check of its own so tests can exercise it directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolveVellumHome } from "@shared/vellum-home";
import { join } from "node:path";
import type { DemoCommand, DemoCommandResult, DemoEdl, DemoWriteEdlResult } from "@shared/demo";
import { ScriptedMirrorTransport } from "./scripted-mirror-transport";

const transports = new Map<string, ScriptedMirrorTransport>();

/** Singleton scripted transport per host id ("local" | "remote-a"). */
export const scriptedTransportFor = (hostId: string): ScriptedMirrorTransport => {
  let transport = transports.get(hostId);
  if (!transport) {
    transport = new ScriptedMirrorTransport();
    transports.set(hostId, transport);
  }
  return transport;
};

export const applyDemoCommand = (cmd: DemoCommand): DemoCommandResult => {
  try {
    switch (cmd.kind) {
      case "ensure-pane": {
        scriptedTransportFor(cmd.pane.host).ensurePane(cmd.pane, cmd.status);
        return { ok: true };
      }
      case "set-status": {
        const applied = scriptedTransportFor(cmd.host).setStatus(cmd.paneId, cmd.status);
        return applied ? { ok: true } : { ok: false, error: `pane not found: ${cmd.paneId}` };
      }
      case "reset-host": {
        scriptedTransportFor(cmd.host).resetHost();
        return { ok: true };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export const writeDemoEdl = async (edl: DemoEdl): Promise<DemoWriteEdlResult> => {
  try {
    const dir = join(resolveVellumHome(), ".vellum", "demo");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `edl-${edl.scenarioId}-${edl.startedAtEpochMs}.json`);
    await writeFile(path, JSON.stringify(edl, null, 2), "utf8");
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
