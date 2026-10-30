import { PassThrough, Writable } from "node:stream";
import { Effect, Exit, Layer, Option, Scope, Schema, Stream } from "effect";
import { InstallationId } from "@shared/installation-id";
import { MachineBuild } from "@shared/machine-control";
import { RemoteHost } from "@shared/remote-hosts";
import { encodeError } from "../failure-encode";
import { MachineRepository, type MachinePeer } from "../machines/repository";
import { parseHostSshRoute, parseSshRoute, SshExitError, SshProcessError, SshTransport } from "../ssh";
import { openMachineLink } from "../ssh/machine-commands";
import { noteMachinesChanged } from "../hosts/machine-changes";
import { boatRoute } from "../boat/machines";
import { linkLog } from "./log";
import { readBoundRoute } from "./link-keys";
import { makeLinkSession } from "./session";
import { LinkHelloSchema } from "./protocol";
import { MachineLink, type MachineLinkListener } from "./service";
import { startLinkListener } from "./listener";
import {
  isMachineLinkError, LinkBuildMismatch, linkClosed, LinkHelloRefused, LinkPeerNotPinned, LinkUnavailable,
  isLinkChannel, LINK_CHANNELS, type LinkChannel, type LinkChannelHandler, type LinkChannels, type LinkHello, type LinkSession, type MachineLinkError,
} from "./types";

/** How long a closing link waits for its SSH process to say how it ended. */
const PROCESS_END_WAIT_MS = 2_000;

/** Every failure becomes a link failure that keeps its first cause. */
const toLinkError = (cause: unknown, machine?: string): MachineLinkError => {
  if (isMachineLinkError(cause)) return cause;
  const where = machine === undefined ? {} : { machine };
  if (cause instanceof SshProcessError || cause instanceof SshExitError) {
    const exitCode = cause instanceof SshExitError ? cause.code : cause.exitCode;
    return linkClosed({ ...where, by: "process", reason: "process-exited", cause,
      ...(cause.signal === undefined && exitCode !== undefined && exitCode >= 0 ? { exitCode } : {}),
      ...(cause.signal === undefined ? {} : { signal: cause.signal }),
      ...(cause.stderrTail === undefined ? {} : { stderrTail: cause.stderrTail }),
      ...(cause.stderrCut === undefined ? {} : { stderrCut: true }) });
  }
  return linkClosed({ ...where, by: "this-end", reason: "failed", cause });
};

/**
 * `home` holds this machine's link keys: a peer with a bound route recorded
 * there is dialed with that route and key only (link-keys.ts).
 */
export const makeMachineLink = (options: { readonly build: string; readonly home?: string }) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const ssh = yield* SshTransport;
  const context = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromiseWith(context)(effect);
  const fork = Effect.runForkWith(context);
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
  const shuttingDown = () => new LinkUnavailable({ reason: "shutting-down", message: "Machine links are shutting down" });
  const activePeer = async (hello: LinkHello): Promise<MachinePeer> => {
    const peer = await run(machines.peer(hello.machineName));
    if (peer === undefined || peer.installationId !== hello.installationId) {
      throw new LinkPeerNotPinned({ machine: hello.machineName, installationId: hello.installationId, message: `${hello.machineName} is not bound to an active peer with that name and installation` });
    }
    return peer;
  };
  const admission = (host?: RemoteHost, setupId?: InstallationId) => {
    let setupCommitted = false;
    return async (raw: LinkHello, opener?: InstallationId): Promise<void> => {
      if (stopping) throw shuttingDown();
      let hello: LinkHello;
      try { hello = Schema.decodeUnknownSync(LinkHelloSchema, { onExcessProperty: "error" })(raw); }
      catch { throw new LinkHelloRefused({ check: "decode", message: "The link hello does not match its schema" }); }
      const own = await self();
      if (hello.machineName === own.machineName || hello.installationId === own.installationId) throw new LinkHelloRefused({ machine: hello.machineName, check: "self-link", message: "A link must reach another machine" });
      if (host !== undefined && hello.machineName !== host.id) throw new LinkHelloRefused({ machine: host.id, check: "route-name", message: `The SSH route for ${host.id} reaches a machine named ${hello.machineName}` });
      if (setupId !== undefined && hello.installationId !== setupId) throw new LinkHelloRefused({ machine: hello.machineName, check: "setup-identity", message: "The SSH route does not match the installed machine identity" });
      if (setupId === undefined || setupCommitted) {
        const peer = await activePeer(hello);
        // A peer pinned with a key links only through that key's forced command, which names it.
        if (host === undefined && peer.binding === "key" && opener === undefined) {
          throw new LinkHelloRefused({ machine: hello.machineName, check: "opener-key-required", message: `${hello.machineName} links to this machine only with its link key` });
        }
      }
      // Only a checked existing binding can contribute a build warning.
      if (setupId === undefined || setupCommitted) {
        builds.set(hello.machineName, hello.build);
        noteMachinesChanged();
      }
      if (hello.build !== own.build) throw LinkBuildMismatch.of(hello, own.build);
      if (setupId !== undefined && !setupCommitted) {
        await run(machines.pinPeer({ machineName: hello.machineName, installationId: hello.installationId }));
        setupCommitted = true;
        builds.set(hello.machineName, hello.build);
        noteMachinesChanged();
      }
    };
  };
  /** The installation that dialed each admitted link. */
  const dialers = new WeakMap<LinkSession, InstallationId>();
  /**
   * Two links to one machine settle to one, the same one at both ends: the
   * link dialed by the lower installation id is kept and the other closes as
   * superseded before its channels open. Two dialed by the same machine keep
   * the newer, so a machine that restarted is not refused by its old link.
   */
  const settle = (session: LinkSession, hello: LinkHello, dialer: InstallationId): void => {
    const existing = sessions.get(hello.machineName);
    if (existing !== undefined && existing !== session) {
      const kept = dialers.get(existing);
      if (kept !== undefined && kept < dialer) throw linkClosed({ machine: hello.machineName, by: "this-end", reason: "superseded" });
      void existing.close(linkClosed({ machine: hello.machineName, by: "this-end", reason: "superseded" }));
    }
    dialers.set(session, dialer);
    sessions.set(hello.machineName, session);
  };
  /** A session that settles with the others to its peer; `dialed` when this end opened it. */
  const open = (options: Omit<Parameters<typeof makeLinkSession>[0], "admitted">, dialed: boolean): LinkSession => {
    let session: LinkSession | undefined;
    session = makeLinkSession({ ...options, admitted: (hello) => settle(session!, hello, dialed ? options.self.installationId : hello.installationId) });
    return track(session);
  };
  const track = (session: LinkSession): LinkSession => {
    allSessions.add(session);
    void session.closed.then(() => {
      allSessions.delete(session);
      for (const [name, held] of sessions) if (held === session) sessions.delete(name);
    });
    return session;
  };
  const dial = async (host: RemoteHost, setupId?: InstallationId): Promise<MachinePeer> => {
    if (!configured) throw new LinkUnavailable({ machine: host.id, reason: "not-configured", message: "Machine links are not accepting connections yet" });
    if (stopping) throw shuttingDown();
    const pin = await run(machines.peer(host.id));
    if (setupId === undefined && pin === undefined) throw new LinkPeerNotPinned({ machine: host.id, message: `Set up ${host.id} before opening a link` });
    if (sessions.has(host.id)) {
      const hello = await sessions.get(host.id)!.ready;
      await admission(host, setupId)(hello);
      return await activePeer(hello);
    }
    if (host.isThisMachine || host.juntoHome === undefined || host.installRoot === undefined) {
      throw new LinkUnavailable({ machine: host.id, reason: "route-incomplete", message: "A machine link requires the selected SSH route and install location" });
    }
    const scope = await run(Scope.make("sequential"));
    let session: LinkSession | undefined;
    try {
      // A bound route is dialed with its own key and known hosts only; a Boat
      // machine's address and host key change as it sleeps and wakes: found now, never stored as truth.
      const bound = options.home === undefined ? undefined : readBoundRoute(options.home, host.id);
      const target = bound === undefined ? await run(parseHostSshRoute(await boatRoute(host)))
        : await run(parseSshRoute({ endpoint: `${bound.user}@${bound.host}`, port: bound.port, identityFile: bound.identityFile, knownHostsFile: bound.knownHostsFile, bound: true }));
      const program = await run(openMachineLink(target, { juntoHome: host.juntoHome, installRoot: host.installRoot }));
      const own = await self();
      const connected = await run(ssh.connect(program, (lease, confirm) => Effect.gen(function* () {
        const input = new PassThrough({ highWaterMark: 64 * 1024 });
        const output = new Writable({ highWaterMark: 64 * 1024, write: (chunk: Buffer, _encoding, callback) => {
          void run(lease.write(chunk)).then(() => callback(), (cause) => callback(toLinkError(cause, host.id) as Error));
        } });
        session = open({ readable: input, writable: output, self: own, admit: admission(host, setupId), channels, run, expected: host.id, ...(bound === undefined ? {} : { keyBound: true as const }) }, true);
        const held = session;
        // The first cause wins: when the process ends, the link closes with its exit and stderr tail.
        const processEnded = Effect.gen(function* () {
          const end = lease.ended === undefined ? Option.none() : yield* lease.ended.pipe(Effect.timeoutOption(PROCESS_END_WAIT_MS));
          if (Option.isSome(end)) {
            yield* Effect.promise(() => held.close(linkClosed({ machine: host.id, by: "process", reason: "process-exited", ...end.value })));
          }
          input.destroy();
        });
        yield* Effect.forkIn(Stream.runForEach(lease.stdout, (chunk) => Effect.tryPromise({
          try: () => new Promise<void>((resolve, reject) => input.write(Buffer.from(chunk), (cause) => cause ? reject(cause) : resolve())),
          catch: (cause) => toLinkError(cause, host.id),
        })).pipe(Effect.exit, Effect.andThen(processEnded)), scope);
        // The bytes are read for the lease's scrubbed tail; a closed pipe is the process end, told above.
        yield* Effect.forkIn(Stream.runForEach(lease.stderr, () => Effect.void).pipe(Effect.catchTag("SshProcessError", () => Effect.void)), scope);
        yield* Effect.forkIn(lease.exitCode.pipe(Effect.exit, Effect.andThen(processEnded)), scope);
        const hello = yield* Effect.tryPromise({ try: () => held.ready, catch: (cause) => toLinkError(cause, host.id) });
        return confirm(hello);
      })).pipe(Effect.provideService(Scope.Scope, scope)));
      const held = session!;
      void held.closed.then(() => run(Scope.close(scope, Exit.void)));
      return await activePeer(connected);
    } catch (cause) {
      const failure = toLinkError(cause, host.id);
      if (session !== undefined) await session.close(failure);
      await run(Scope.close(scope, Exit.void));
      // The other machine's link to this one was kept: this dial reached it.
      const kept = sessions.get(host.id);
      if (failure._tag === "LinkClosed" && failure.reason === "superseded" && kept !== undefined && kept !== session) {
        const hello = await kept.ready;
        if (setupId !== undefined) await admission(host, setupId)(hello);
        return await activePeer(hello);
      }
      await run(linkLog("Warning", "link dial failed", { machine: host.id, failure: encodeError(failure, { machine: host.id }) }));
      throw failure;
    }
  };
  const connect = Effect.fn("MachineLink.connect")(function* (host: RemoteHost, setupId?: InstallationId) {
    const selected = yield* Schema.decodeUnknownEffect(RemoteHost, { onExcessProperty: "error" })(host).pipe(
      Effect.mapError(() => new LinkUnavailable({ reason: "route-incomplete", message: "The machine route does not match its schema" })));
    if (setupId !== undefined) yield* Schema.decodeUnknownEffect(InstallationId)(setupId).pipe(
      Effect.mapError(() => new LinkUnavailable({ machine: selected.id, reason: "other-installation", message: "The installer receipt is not an installation id" })));
    return yield* Effect.tryPromise({ try: async () => {
      const pending = dials.get(selected.id);
      if (pending !== undefined) {
        const peer = await pending;
        if (setupId !== undefined && peer.installationId !== setupId) throw new LinkUnavailable({ machine: selected.id, reason: "other-installation", message: "The pending link reaches another installation" });
        return peer;
      }
      const flight = dial(selected, setupId);
      dials.set(selected.id, flight);
      try { return await flight; } finally { if (dials.get(selected.id) === flight) dials.delete(selected.id); }
    }, catch: (cause) => toLinkError(cause, selected.id) });
  });
  const disconnect = Effect.fn("MachineLink.disconnect")(function* (name: string, cause?: unknown) {
    const session = sessions.get(name);
    if (session !== undefined) yield* Effect.tryPromise({ try: () => session.close(cause), catch: (failure) => toLinkError(failure, name) });
  });
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    stopping = true;
    listener?.beginShutdown();
    await Promise.all([...allSessions].map((session) => session.close(shuttingDown())));
    if (listener !== undefined) await listener.close();
  }));
  const sessionFor = (name: string): LinkSession => {
    if (stopping) throw shuttingDown();
    const session = sessions.get(name);
    if (session === undefined) throw new LinkUnavailable({ machine: name, reason: "not-linked", message: `${name} is not linked` });
    return session;
  };
  return MachineLink.of({
    setChannels: (next) => Effect.try({ try: () => {
      if (configured || allSessions.size !== 0 || listener !== undefined) throw new LinkUnavailable({ reason: "channels-bound", message: "Link channels are already bound" });
      for (const name of Object.keys(next)) if (!isLinkChannel(name)) throw new LinkUnavailable({ reason: "unknown-channel", message: `Unknown link channel ${name}` });
      const bound: Partial<Record<LinkChannel, LinkChannelHandler>> = { ...next };
      const missing = LINK_CHANNELS.filter((name) => bound[name] === undefined);
      if (missing.length > 0) throw new LinkUnavailable({ reason: "missing-channel", message: `Link channels are not all bound: ${missing.join(", ")}` });
      channels = Object.freeze(bound);
      configured = true;
    }, catch: (cause) => toLinkError(cause) }),
    listen: Effect.fn("MachineLink.listen")(function* (home: string) {
      return yield* Effect.tryPromise({ try: async () => {
        if (!configured || stopping || listener !== undefined) throw new LinkUnavailable({ reason: "listener-unavailable", message: "Machine link listener is not available" });
        const { machineName: machine } = await self();
        listener = await startLinkListener({ home, accept: async (socket) => {
          if (stopping) throw shuttingDown();
          return open({ readable: socket, writable: socket, self: await self(), admit: admission(), channels, run, acceptsOpener: true }, false);
        }, failed: (what, cause) => {
          fork(linkLog("Warning", what === "accept" ? "link connection was not accepted" : "link listener failed", { machine, failure: encodeError(cause, { machine }) }));
        } });
        return listener;
      }, catch: (cause) => toLinkError(cause) });
    }),
    connect: (host) => connect(host),
    connectSetup: (host, expectedInstallationId) => connect(host, expectedInstallationId),
    disconnect,
    peerBuild: (name) => Effect.sync(() => builds.get(name)),
    request: Effect.fn("MachineLink.request")(function* (name: string, channel: LinkChannel, payload: unknown, requestOptions?: { readonly operationId?: string }) {
      return yield* Effect.tryPromise({ try: () => sessionFor(name).request(channel, payload, requestOptions?.operationId), catch: (cause) => toLinkError(cause, name) });
    }),
    sendEvent: Effect.fn("MachineLink.sendEvent")(function* (name: string, channel: LinkChannel, payload: unknown) {
      return yield* Effect.tryPromise({ try: () => sessionFor(name).sendEvent(channel, payload), catch: (cause) => toLinkError(cause, name) });
    }),
  });
});

export const machineLinkLayer = (build: string, home?: string) => Layer.effect(MachineLink, makeMachineLink({ build, ...(home === undefined ? {} : { home }) }));
