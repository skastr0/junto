import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { coreControlSocketPath } from "../src/main/junto/link/listener";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "../src/main/junto/link/protocol";
import { MachineRepository } from "../src/main/junto/machines/repository";

const connectPeer = async (home: string, hello: typeof LinkHelloSchema.Type) => {
  const socket = createConnection(coreControlSocketPath(home));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames: LinkFrame[] = [];
  let buffered = "";
  let receive: ((frame: LinkFrame) => void) | undefined;
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const frame = decodeLinkFrame(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      frames.push(frame);
      receive?.(frame);
    }
  });
  socket.on("error", () => undefined);
  const closed = new Promise<void>(resolve => { socket.once("close", () => resolve()); });
  socket.write(JSON.stringify({ type: "hello", ...hello }) + "\n");
  return {
    request: async (id: string, channel: "status" | "seats" = "status", payload: unknown = { kind: "machine" }) => {
      const response = new Promise<LinkFrame>(resolve => {
        receive = frame => { if (frame.type === "response" && frame.id === id) resolve(frame); };
      });
      socket.write(JSON.stringify({ type: "request", id, channel, payload }) + "\n");
      return Promise.race([response, closed.then(() => undefined)]);
    },
    close: async () => { socket.destroy(); await closed; },
    frames,
  };
};

it("admits account-local links only for the live name, installation and build pin", async () => {
  const home = await mkdtemp("/tmp/junto-core-pin-");
  const build = "a".repeat(64);
  const pinned = Schema.decodeUnknownSync(LinkHelloSchema)({ machineName: "mini", installationId: "mini-installation", build });
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  const peers: Awaited<ReturnType<typeof connectPeer>>[] = [];
  try {
    core = await startCore({ home, build, bundles: {} });
    const machines = await core.runtime.runPromise(MachineRepository);
    await core.runtime.runPromise(machines.configureName("book"));
    await core.runtime.runPromise(machines.pinPeer({ machineName: pinned.machineName, installationId: pinned.installationId }));
    for (const hello of [
      { ...pinned, machineName: "unknown" },
      { ...pinned, installationId: "other-installation" },
      { ...pinned, build: "b".repeat(64) },
    ]) {
      const peer = await connectPeer(home, Schema.decodeUnknownSync(LinkHelloSchema)(hello));
      peers.push(peer);
      expect(await peer.request("refused")).toBeUndefined();
      expect(peer.frames.some(frame => frame.type === "response")).toBe(false);
    }
    const peer = await connectPeer(home, pinned);
    peers.push(peer);
    expect(await peer.request("admitted")).toMatchObject({
      type: "response", id: "admitted", channel: "status", ok: true,
      payload: { machineName: "book", reachable: true },
    });
    expect(await peer.request("seat-start", "seats", { _tag: "Start", canvas: "missing-canvas", seatId: "missing-seat" }))
      .toMatchObject({ type: "response", id: "seat-start", channel: "seats", ok: false });
    expect(await peer.request("still-admitted")).toMatchObject({ type: "response", id: "still-admitted", ok: true });
    await core.runtime.runPromise(machines.retirePeer(pinned.machineName));
    expect(await peer.request("retired")).toBeUndefined();
    expect(peer.frames.some(frame => frame.type === "response" && frame.id === "retired")).toBe(false);
  } finally {
    await Promise.all(peers.map(peer => peer.close()));
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
