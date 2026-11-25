/**
 * A hello carries what its build says it is, its release and when it was
 * built, so two machines on different builds can say which one to update
 * (remote-verify receipt 2). The claim is display only: build equality alone
 * admits a link (docs/security-doctrine.md, The link).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { coreControlSocketPath } from "../src/core/link/listener";
import { machineLinkLayer } from "../src/core/link/live";
import { LinkHelloSchema } from "../src/core/link/protocol";
import { MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { LinkBuildMismatch, type LinkHello } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { SshTransport } from "../src/core/ssh/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { MachineBuild, MachineName, type MachineRelease } from "../src/shared/machine-control";
import { allChannels } from "./support/link-channels";
import { noBoatRoutesLayer } from "./support/no-boat";

const NEW = "b".repeat(64);
const OLD = "a".repeat(64);
const hello = (machineName: string, build: string, release: MachineRelease = {}): LinkHello => ({
  machineName, build, installationId: `${machineName}-install` as LinkHello["installationId"], ...release,
});

describe("the mismatch names the machine to update", () => {
  it("says the peer when the peer runs the older release", () => {
    const mismatch = LinkBuildMismatch.of(hello("book", OLD, { version: "0.11.15" }), hello("mini", NEW, { version: "0.12.0" }));
    expect(mismatch.direction).toBe("peer-older");
    expect(mismatch.message).toBe("book says it runs Junto 0.11.15; mini runs Junto 0.12.0. Update book.");
  });

  it("says this machine by its name when this machine is the older one", () => {
    const mismatch = LinkBuildMismatch.of(hello("book", NEW, { version: "0.12.0" }), hello("mini", OLD, { version: "0.11.15" }));
    expect(mismatch.direction).toBe("this-older");
    expect(mismatch.message).toBe("book says it runs Junto 0.12.0; mini runs Junto 0.11.15. Update mini.");
  });

  it("takes a peer that names no release for a build from before releases were named", () => {
    const mismatch = LinkBuildMismatch.of(hello("book", OLD), hello("mini", NEW, { version: "0.12.0" }));
    expect(mismatch.direction).toBe("peer-older");
    expect(mismatch.message).toBe("book runs an older build of Junto; mini runs Junto 0.12.0. Update book.");
  });

  it("orders two builds of one release by when each was built, and a prerelease before its release", () => {
    const early = { version: "0.12.0", builtAt: "2026-11-20T10:00:00Z" };
    const late = { version: "0.12.0", builtAt: "2026-11-24T10:00:00.000Z" };
    expect(LinkBuildMismatch.of(hello("book", OLD, early), hello("mini", NEW, late)).message)
      .toBe("book says it runs Junto 0.12.0 (Nov 20); mini runs Junto 0.12.0 (Nov 24). Update book.");
    expect(LinkBuildMismatch.of(hello("book", OLD, { version: "0.12.0-rc.1" }), hello("mini", NEW, { version: "0.12.0" })).direction).toBe("peer-older");
  });

  it("names both and says to send from the newer one when nothing tells them apart", () => {
    const mismatch = LinkBuildMismatch.of(hello("book", OLD, { version: "0.12.0" }), hello("mini", NEW, { version: "0.12.0" }));
    expect(mismatch.direction).toBe("different");
    expect(mismatch.message).toBe("book and mini run different builds of Junto (book says it runs Junto 0.12.0, mini runs Junto 0.12.0). Send Junto from the newer one to the other.");
  });

  it("says nothing of what each runs when neither named it", () => {
    expect(LinkBuildMismatch.of(hello("book", OLD), hello("mini", NEW)).message)
      .toBe("book and mini run different builds of Junto. Send Junto from the newer one to the other.");
  });

  it("never says \"this machine\"", () => {
    for (const [peer, local] of [[OLD, NEW], [NEW, OLD]] as const) {
      expect(LinkBuildMismatch.of(hello("book", peer, { version: "0.12.0" }), hello("mini", local)).message).not.toMatch(/this machine/iu);
    }
  });
});

describe("the hello's release fields", () => {
  it("are optional, so a hello from a build before them still decodes", () => {
    const strict = Schema.decodeUnknownSync(LinkHelloSchema, { onExcessProperty: "error" });
    expect(strict({ build: OLD, installationId: "book-install", machineName: "book" })).toEqual({ build: OLD, installationId: "book-install", machineName: "book" });
    expect(strict({ build: NEW, installationId: "mini-install", machineName: "mini", version: "0.12.0", builtAt: "2026-11-24T10:00:00Z" }).version).toBe("0.12.0");
  });

  it("refuse a release or build time that is not one", () => {
    const strict = Schema.decodeUnknownSync(LinkHelloSchema, { onExcessProperty: "error" });
    expect(() => strict({ build: NEW, installationId: "mini-install", machineName: "mini", version: "dev" })).toThrow();
    expect(() => strict({ build: NEW, installationId: "mini-install", machineName: "mini", builtAt: "yesterday" })).toThrow();
  });

  it("are refused by a build from before them, which closes a link its build check refuses anyway", () => {
    // The hello schema as builds before 0.12 have it: strict, with no release fields.
    const older = Schema.decodeUnknownSync(Schema.Struct({ build: MachineBuild, installationId: InstallationId, machineName: MachineName }), { onExcessProperty: "error" });
    expect(() => older({ build: NEW, installationId: "mini-install", machineName: "mini", version: "0.12.0" })).toThrow();
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const eventually = async (check: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

/** The mini: a real MachineLink on its owner socket, on build NEW, with "book" pinned. */
const mini = async (release?: MachineRelease) => {
  const home = await mkdtemp(join("/tmp", "junto-hello-mini-"));
  const ssh = SshTransport.of({
    run: () => Effect.die("no one-shot commands"), transfer: () => Effect.die("no transfers"),
    forward: () => Effect.die("no forwards"), warm: () => Effect.void, teardown: () => Effect.void,
    connect: () => Effect.die(new Error("no dials in this test")),
  } as never);
  const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer(NEW, undefined, release), Layer.mergeAll(
    noBoatRoutesLayer, Layer.succeed(SshTransport, ssh),
    Layer.provide(makeMachineRepositoryLive({ defaultName: () => "mini" }), makeStateEngineLive(join(home, "junto.db"))),
  )));
  cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
  await runtime.runPromise(Effect.gen(function* () {
    yield* (yield* MachineRepository).pinPeer({ machineName: "book", installationId: Schema.decodeUnknownSync(InstallationId)("book-install") });
    const link = yield* MachineLink;
    yield* link.setChannels(allChannels());
    yield* link.listen(home);
  }));
  return { home, runtime };
};

/** Book links into the mini saying `self`; answers the mini's hello and how the link ended. */
const linkIn = async (home: string, self: LinkHello) => {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = createConnection(coreControlSocketPath(home));
    opened.once("connect", () => resolve(opened));
    opened.once("error", reject);
  });
  let heard: LinkHello | undefined;
  const far = makeLinkSession({ readable: socket, writable: socket, self: Schema.decodeUnknownSync(LinkHelloSchema)(self),
    admit: async (peer) => { heard = peer; }, channels: allChannels(), run: Effect.runPromise });
  cleanups.push(async () => { await far.close(); socket.destroy(); });
  const ended = await far.ready.then(() => undefined, (error: unknown) => error);
  return { heard: () => heard, ended };
};

describe("a link between two builds", () => {
  it("carries each end's release, names the machine to update at both ends, and keeps what the peer said", async () => {
    const { home, runtime } = await mini({ version: "0.12.0", builtAt: "2026-11-24T10:00:00Z" });
    const book = await linkIn(home, hello("book", OLD, { version: "0.11.15", builtAt: "2026-11-10T10:00:00Z" }));
    expect(book.heard()).toMatchObject({ machineName: "mini", build: NEW, version: "0.12.0", builtAt: "2026-11-24T10:00:00Z" });
    // Book's own end sees the mini is newer, and names itself by name.
    expect(book.ended).toBeInstanceOf(LinkBuildMismatch);
    expect((book.ended as LinkBuildMismatch).message).toBe("mini says it runs Junto 0.12.0 (Nov 24); book runs Junto 0.11.15 (Nov 10). Update book.");
    // The mini kept book's claim, for its list after a restart.
    await eventually(async () => {
      expect(await runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.peersSeen))).toEqual([
        expect.objectContaining({ machineName: "book", installationId: "book-install", build: OLD, version: "0.11.15", builtAt: "2026-11-10T10:00:00Z" }),
      ]);
    });
  });

  it("leaves out a release its schema refuses, as a development build's \"dev\"", async () => {
    const { home } = await mini({ version: "dev" });
    const book = await linkIn(home, hello("book", OLD));
    expect(book.heard()).toEqual({ machineName: "mini", build: NEW, installationId: expect.any(String) });
  });
});
