/**
 * Surface ports reach the view that holds their lease: one that arrives
 * before the view asks waits for it, a later one for the same lease goes to
 * the same view, and a message from anywhere but this window is ignored.
 */
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";

type Listener = (event: { readonly source: unknown; readonly data: unknown; readonly ports: readonly unknown[] }) => void;

let listener: Listener | undefined;
const fakeWindow = { addEventListener: (_type: string, next: Listener) => (listener = next) };
const ports: Array<{ close: () => void }> = [];

beforeEach(() => {
  vi.resetModules();
  listener = undefined;
  vi.stubGlobal("window", fakeWindow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const port of ports.splice(0)) port.close();
});

const post = (leaseId: string, source: unknown = fakeWindow) => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  listener?.({ source, data: { type: IPC_CHANNELS.terminalSurface, leaseId }, ports: [port2] });
  return port2;
};

describe("surface ports for a lease", () => {
  it("delivers one that arrived early, then each later one, to the view that holds the lease", async () => {
    const { takeSurfacePorts } = await import("../src/renderer/lib/terminal-surface-port");
    const taken: unknown[] = [];
    takeSurfacePorts("other", () => undefined);
    const early = post("lease-1");
    takeSurfacePorts("lease-1", (port) => taken.push(port));
    expect(taken).toEqual([early]);
    const later = post("lease-1");
    expect(taken).toEqual([early, later]);
  });

  it("holds a port that arrives before any view has asked, from the moment the module loads", async () => {
    const { takeSurfacePorts } = await import("../src/renderer/lib/terminal-surface-port");
    // Main posts the port before it answers the attach: nothing has asked yet.
    const first = post("lease-1");
    const taken: unknown[] = [];
    takeSurfacePorts("lease-1", (port) => taken.push(port));
    expect(taken).toEqual([first]);
  });

  it("ignores a message that did not come from this window", async () => {
    const { takeSurfacePorts } = await import("../src/renderer/lib/terminal-surface-port");
    const taken: unknown[] = [];
    takeSurfacePorts("lease-1", (port) => taken.push(port));
    post("lease-1", {});
    expect(taken).toEqual([]);
  });
});
