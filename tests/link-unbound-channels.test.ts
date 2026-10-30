import { PassThrough } from "node:stream";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { machineLinkLayer } from "../src/main/junto/link/live";
import { MachineLink } from "../src/main/junto/link/service";
import { makeLinkSession } from "../src/main/junto/link/session";
import { LINK_CHANNELS, LinkRequestFailed, type LinkChannelHandler } from "../src/main/junto/link/types";
import { unboundYet } from "../src/main/junto/link/unbound";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { SshTransport } from "../src/main/junto/ssh/service";
import { allChannels } from "./support/link-channels";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const harness = async () => {
  const home = await mkdtemp(join(tmpdir(), "junto-link-catalog-"));
  const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer("c".repeat(64), home), Layer.mergeAll(
    Layer.provide(makeMachineRepositoryLive({ defaultName: () => "studio" }), makeStateEngineLive(join(home, "junto.db"))),
    Layer.succeed(SshTransport, {} as never),
  )));
  cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
  const bind = (channels: Parameters<typeof allChannels>[0]) =>
    runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.setChannels(channels as never))).then(() => "bound", (cause) => cause as { reason?: string; message?: string });
  return { bind };
};

it("binds the whole catalog, with the stub standing on the two channels that have no owner yet", async () => {
  const { bind } = await harness();
  const { consensus: _consensus, authority: _authority, ...owned } = allChannels();
  expect(await bind(owned)).toBe("bound");
});

it("refuses to bind without a catalog channel, naming it, and without files above all", async () => {
  for (const missing of LINK_CHANNELS.filter((name) => name !== "consensus" && name !== "authority")) {
    const { [missing]: _left, ...rest } = allChannels();
    const refused = await harness().then(({ bind: fresh }) => fresh(rest));
    expect(refused, missing).toMatchObject({ reason: "missing-channel" });
    expect((refused as { message: string }).message).toContain(missing);
  }
});

it("refuses a name outside the catalog", async () => {
  const { bind } = await harness();
  expect(await bind({ ...allChannels(), shell: unboundYet("files") } as never)).toMatchObject({ reason: "unknown-channel" });
});

const hello = (name: string) => Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: `${name}-install`, machineName: name });

it("refuses a request on an unbound-yet channel and drops its events, with the link and the other channels intact", async () => {
  const echo: LinkChannelHandler = {
    decodeRequest: (payload) => payload, decodeResponse: (payload) => payload, decodeEvent: (payload) => payload,
    handleRequest: (_context, payload) => Effect.succeed(payload),
  };
  const toHost = new PassThrough();
  const toPeer = new PassThrough();
  const host = makeLinkSession({ readable: toHost, writable: toPeer, self: hello("mini"), admit: async () => {}, run: Effect.runPromise, channels: { status: echo, consensus: unboundYet("consensus") } });
  const peer = makeLinkSession({ readable: toPeer, writable: toHost, self: hello("macbook"), admit: async () => {}, run: Effect.runPromise, channels: { status: echo, consensus: unboundYet("consensus") } });
  cleanups.push(async () => { await Promise.all([host.close(), peer.close()]); });
  await Promise.all([host.ready, peer.ready]);
  await expect(peer.request("consensus", { vote: 1 })).rejects.toBeInstanceOf(LinkRequestFailed);
  await peer.sendEvent("consensus", { heartbeat: 1 });
  await peer.sendEvent("consensus", { heartbeat: 2 });
  expect(await peer.request("status", { still: "open" })).toEqual({ still: "open" });
});
