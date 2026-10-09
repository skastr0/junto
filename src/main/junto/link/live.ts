import { PassThrough, Writable } from "node:stream";
import { Context, Effect, Exit, Layer, Scope, Schema, Stream } from "effect";
import { InstallationId } from "@shared/installation-id";
import { MachineBuild } from "@shared/machine-control";
import { RemoteHost } from "@shared/remote-hosts";
import { MachineRepository, type MachinePeer } from "../machines/repository";
import { parseHostSshRoute, SshTransport } from "../ssh";
import { openMachineLink } from "../ssh/machine-commands";
import { makeLinkSession } from "./session";
import { LinkHelloSchema } from "./protocol";
import { MachineLink, type MachineLinkListener } from "./service";
import { startLinkListener } from "./listener";
import { MachineLinkError, type LinkChannels, type LinkHello, type LinkSession } from "./types";

const failure = (cause: unknown): MachineLinkError => cause instanceof MachineLinkError ? cause :
  new MachineLinkError(cause instanceof Error ? cause.message : "The machine link failed");

export const makeMachineLink = (options: { readonly build: string }) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const ssh = yield* SshTransport;
  const context = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromiseWith(context)(effect);
  const build = yield* Schema.decodeUnknownEffect(MachineBuild)(options.build);
  const sessions = new Map<string, LinkSession>();
  const allSessions = new Set<LinkSession>();
  const builds = new Map<string, string>();
  const dials = new Map<string, Promise<MachinePeer>>();
  let channels: LinkChannels = {};
  let configured = false;
  let stopping = false;
  let listener: MachineLinkListener | undefined;
  const self = () => run(Effect.all({ build: Effect.succeed(build), installationId: machines.installationId, machineName: machines.machineName }));
  const activePeer = async (hello: LinkHello): Promise<MachinePeer> => {
    const peer = await run(machines.peer(hello.machineName));
    if (peer === undefined || peer.installationId !== hello.installationId) throw new MachineLinkError("This machine is not bound to an active peer with that name and installation");
    return peer;
  };
  const admission = (host?: RemoteHost, setupId?: InstallationId) => {
    let setupCommitted = false;
    return async (raw: LinkHello): Promise<void> => {
      if (stopping) throw new MachineLinkError("Machine links are shutting down");
      const hello = Schema.decodeUnknownSync(LinkHelloSchema, { onExcessProperty: "error" })(raw);
      const own = await self();
      if (hello.machineName === own.machineName || hello.installationId === own.installationId) throw new MachineLinkError("A link must reach another machine");
      if (host !== undefined && hello.machineName !== host.id) throw new MachineLinkError("The selected SSH route reaches a different machine name");
      if (setupId !== undefined && hello.installationId !== setupId) throw new MachineLinkError("The SSH route does not match the installed machine identity");
      if (setupId === undefined || setupCommitted) await activePeer(hello);
      // Only a checked existing binding can contribute a build warning.
      if (setupId === undefined || setupCommitted) builds.set(hello.machineName, hello.build);
      if (hello.build !== own.build) throw new MachineLinkError(`Update Junto on ${hello.machineName} to match this build`);
      if (setupId !== undefined && !setupCommitted) {
        await run(machines.pinPeer({ machineName: hello.machineName, installationId: hello.installationId }));
        setupCommitted = true;
        builds.set(hello.machineName, hello.build);
      }
    };
  };
  const track = (session: LinkSession): LinkSession => {
    allSessions.add(session);
    void session.ready.then((hello) => {
      const existing = sessions.get(hello.machineName);
      if (existing !== undefined && existing !== session) {
        void session.close();
        return;
      }
      sessions.set(hello.machineName, session);
    }).catch(() => undefined);
    void session.closed.then(() => {
      allSessions.delete(session);
      for (const [name, held] of sessions) if (held === session) sessions.delete(name);
    });
    return session;
  };
  const dial = async (host: RemoteHost, setupId?: InstallationId): Promise<MachinePeer> => {
    if (!configured || stopping) throw new MachineLinkError("Machine links are not accepting connections");
    const pin = await run(machines.peer(host.id));
    if (setupId === undefined && pin === undefined) throw new MachineLinkError("Set up this machine before opening a link");
    if (sessions.has(host.id)) {
      const hello = await sessions.get(host.id)!.ready;
      await admission(host, setupId)(hello);
      return await activePeer(hello);
    }
    if (host.isThisMachine || host.juntoHome === undefined || host.installRoot === undefined) throw new MachineLinkError("A machine link requires the selected SSH route and install location");
    const scope = await run(Scope.make("sequential"));
    let session: LinkSession | undefined;
    try {
      const target = await run(parseHostSshRoute(host));
      const program = await run(openMachineLink(target, { juntoHome: host.juntoHome, installRoot: host.installRoot }));
      const own = await self();
      const connected = await run(ssh.connect(program, (lease, confirm) => Effect.gen(function* () {
        const input = new PassThrough({ highWaterMark: 64 * 1024 });
        const output = new Writable({ highWaterMark: 64 * 1024, write: (chunk: Buffer, _encoding, callback) => {
          void run(lease.write(chunk)).then(() => callback(), (cause) => callback(failure(cause)));
        } });
        session = track(makeLinkSession({ readable: input, writable: output, self: own, admit: admission(host, setupId), channels, run }));
        const held = session;
        yield* Effect.forkIn(Stream.runForEach(lease.stdout, (chunk) => Effect.tryPromise({
          try: () => new Promise<void>((resolve, reject) => input.write(Buffer.from(chunk), (cause) => cause ? reject(cause) : resolve())), catch: failure,
        })).pipe(Effect.onExit(() => Effect.sync(() => input.destroy()))), scope);
        yield* Effect.forkIn(Stream.runForEach(lease.stderr, () => Effect.void).pipe(Effect.ignore), scope);
        yield* Effect.forkIn(lease.exitCode.pipe(Effect.onExit(() => Effect.sync(() => input.destroy())), Effect.ignore), scope);
        const hello = yield* Effect.tryPromise({ try: () => held.ready, catch: failure });
        return confirm(hello);
      })).pipe(Effect.provideService(Scope.Scope, scope)));
      const held = session!;
      void held.closed.then(() => run(Scope.close(scope, Exit.void))).catch(() => undefined);
      return await activePeer(connected);
    } catch (cause) {
      if (session !== undefined) await session.close();
      await run(Scope.close(scope, Exit.void));
      throw failure(cause);
    }
  };
  const connect = (host: RemoteHost, setupId?: InstallationId) => Effect.tryPromise({ try: async () => {
    const selected = Schema.decodeUnknownSync(RemoteHost, { onExcessProperty: "error" })(host);
    if (setupId !== undefined) Schema.decodeUnknownSync(InstallationId)(setupId);
    const pending = dials.get(selected.id);
    if (pending !== undefined) {
      const peer = await pending;
      if (setupId !== undefined && peer.installationId !== setupId) throw new MachineLinkError("The pending link reaches another installation");
      return peer;
    }
    const flight = dial(selected, setupId);
    dials.set(selected.id, flight);
    try { return await flight; } finally { if (dials.get(selected.id) === flight) dials.delete(selected.id); }
  }, catch: failure });
  const disconnect = (name: string) => Effect.tryPromise({ try: async () => {
    const session = sessions.get(name);
    if (session !== undefined) await session.close();
  }, catch: failure });
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    stopping = true;
    listener?.beginShutdown();
    await Promise.all([...allSessions].map((session) => session.close()));
    if (listener !== undefined) await listener.close();
  }));
  const sessionFor = (name: string): LinkSession => {
    const session = sessions.get(name);
    if (session === undefined || stopping) throw new MachineLinkError("The machine is not linked");
    return session;
  };
  return MachineLink.of({
    setChannels: (next) => Effect.try({ try: () => {
      if (configured || allSessions.size !== 0 || listener !== undefined) throw new MachineLinkError("Link channels are already bound");
      for (const name of Object.keys(next)) if (name !== "rows" && name !== "seats" && name !== "status") throw new MachineLinkError("Unknown link channel");
      channels = Object.freeze({ ...next });
      configured = true;
    }, catch: failure }),
    listen: (home) => Effect.tryPromise({ try: async () => {
      if (!configured || stopping || listener !== undefined) throw new MachineLinkError("Machine link listener is not available");
      listener = await startLinkListener({ home, accept: async (socket) => {
        if (stopping) throw new MachineLinkError("Machine links are shutting down");
        return track(makeLinkSession({ readable: socket, writable: socket, self: await self(), admit: admission(), channels, run }));
      } });
      return listener;
    }, catch: failure }),
    connect: (host) => connect(host),
    connectSetup: (host, expectedInstallationId) => connect(host, expectedInstallationId),
    disconnect,
    peerBuild: (name) => Effect.sync(() => builds.get(name)),
    request: (name, channel, payload) => Effect.tryPromise({ try: () => sessionFor(name).request(channel, payload), catch: failure }),
    sendEvent: (name, channel, payload) => Effect.tryPromise({ try: () => sessionFor(name).sendEvent(channel, payload), catch: failure }),
  });
});

export const machineLinkLayer = (build: string) => Layer.effect(MachineLink, makeMachineLink({ build }));
