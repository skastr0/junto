/**
 * Links bound to their opener's key, set up from the editing machine
 * (docs/machines.md, The link; docs/security-doctrine.md, Links).
 *
 * `machine link <from> <to>` runs here, where a route to both ends already
 * exists. It resolves each route once with `ssh -G`, takes the host key this
 * account already verified for it, and runs every setup session strictly
 * against exactly that key. Then, over those sessions: `from` makes a key for
 * `to`, `to` pins `from` and this machine as key-bound openers and writes
 * their lines, `from` pins this machine likewise, this machine records its own
 * bound routes, and `from` records its route to `to` and dials it once. No
 * machine gets general access to another, and this machine is never dialed.
 *
 * The other four operations are those steps, each run by its own machine's
 * Junto over the editing machine's route.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import type { InstallationId } from "@shared/installation-id";
import type {
  MachineLinkAcceptData, MachineLinkAcceptInput, MachineLinkData, MachineLinkInput, MachineLinkKeyData, MachineLinkKeyInput,
  MachineLinkOpenData, MachineLinkOpenInput, MachineLinkRevokeData, MachineLinkRevokeInput, MachineLinkRoute,
} from "@shared/machine-link";
import {
  MachineLinkAcceptData as AcceptData, MachineLinkKeyData as KeyData, MachineLinkOpenData as OpenData, MachineLinkRevokeData as RevokeData,
} from "@shared/machine-link";
import { OperatorErrorBody } from "@shared/operator-control";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { defaultAuthorizedKeysPath, editAuthorizedKeys, readAuthorizedKeys } from "../companion/authorized-keys";
import { readBoatRecords } from "../boat/files";
import {
  hasLinkLine, linkHomeTag, linkKeyLine, makeLinkKey, readBoundRoute, removeLinkKey, removeLinkLines, upsertLinkLine,
  verifiedHostKeys, writeBoundRoute, writeLinkKnownHosts,
} from "../link/link-keys";
import { MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { parseHostSshRoute, parseSshRoute, SshTransport, type SshError } from "../ssh";
import { makeRemoteCommand } from "../ssh/domain";
import { dedicatedStream, resolveSshConfig } from "../ssh/program";
import { SshTransferExitError } from "../ssh/service";
import { HostsService } from "./service";

export interface MachineLinkSetupOptions {
  readonly home: string;
  /** This machine's `<install>/current/bin/junto`, which a receiver's forced command runs; none outside an installed package. */
  readonly juntoPath: () => string | undefined;
  readonly authorizedKeysPath?: string;
}

const refused = (message: string) => new RemoteHostsError("conflict", message);

/** The fields of `ssh -G` output a bound route is built from, lowercased by key. */
const resolvedFields = (output: string): ReadonlyMap<string, string> => {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) fields.set(line.slice(0, space).toLowerCase(), line.slice(space + 1).trim());
  }
  return fields;
};

export const makeMachineLinkSetup = (options: MachineLinkSetupOptions) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const hosts = yield* HostsService;
  const ssh = yield* SshTransport;
  const link = yield* MachineLink;
  const authorizedKeys = options.authorizedKeysPath ?? defaultAuthorizedKeysPath();

  /**
   * One route as this account's OpenSSH would dial it, and the ed25519 host
   * keys this account already verified for it. A route that needs its config
   * to be dialed at all (a jump, a proxy command, a host-key alias) is refused:
   * a bound link reads no config.
   */
  const resolve = (host: RemoteHost) => Effect.gen(function* () {
    const output = yield* ssh.run(resolveSshConfig(yield* parseHostSshRoute(host)));
    const fields = resolvedFields(output.stdout);
    for (const key of ["proxyjump", "proxycommand"] as const) {
      const value = fields.get(key);
      if (value !== undefined && value !== "none") return yield* Effect.fail(refused(`The route to ${host.id} needs ${key === "proxyjump" ? "a ProxyJump" : "a ProxyCommand"}; a link key dials a direct address only`));
    }
    if (fields.get("hostkeyalias") !== undefined) return yield* Effect.fail(refused(`The route to ${host.id} names a HostKeyAlias; a link key dials a literal host`));
    const port = Number(fields.get("port"));
    const route = { machine: host.id, user: fields.get("user") ?? "", host: fields.get("hostname") ?? "", port };
    const files = [...(fields.get("userknownhostsfile") ?? "").split(" "), ...(fields.get("globalknownhostsfile") ?? "").split(" ")].filter((file) => file.startsWith("/"));
    const hostKeys = yield* Effect.try({ try: () => verifiedHostKeys(files, route.host, route.port), catch: (cause) => refused(`${host.id}: ${(cause as Error).message}`) });
    return { route, hostKeys };
  });

  /** A setup session to `host`, strict against the known-hosts file pinned for it here. */
  const owner = <A>(host: RemoteHost, knownHostsFile: string, op: string, input: unknown, schema: Schema.Codec<A, unknown>) =>
    ownerWith(host, knownHostsFile, op, input, schema);
  const ownerWith = <A>(host: RemoteHost, knownHostsFile: string | undefined, op: string, input: unknown, schema: Schema.Codec<A, unknown>) => Effect.gen(function* () {
    if (host.juntoHome === undefined || host.installRoot === undefined) return yield* Effect.fail(refused(`Send Junto to ${host.id} before linking it`));
    const target = yield* parseSshRoute({
      endpoint: host.sshEndpoint,
      ...(knownHostsFile === undefined ? {} : { knownHostsFile }),
      ...(host.sshPort === undefined ? {} : { port: host.sshPort }),
      ...(host.sshIdentityFile === undefined ? {} : { identityFile: host.sshIdentityFile }),
    });
    const command = yield* makeRemoteCommand("/usr/bin/env", [`JUNTO_HOME=${host.juntoHome}`, `${host.installRoot}/current/bin/junto`, "machine", op, "-"]);
    const answer = Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal(`machine ${op}`), data: schema }));
    const failure = Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(false), command: Schema.Literal(`machine ${op}`), error: OperatorErrorBody }));
    const result = yield* ssh.transfer(dedicatedStream(target, command), Stream.make(new TextEncoder().encode(JSON.stringify(input))), 30_000).pipe(
      Effect.catch((cause): Effect.Effect<never, RemoteHostsError | SshTransferExitError | SshError> => {
        if (cause instanceof SshTransferExitError) {
          const said = Schema.decodeUnknownResult(failure, { onExcessProperty: "error" })(cause.stderr.trim().split("\n").at(-1));
          if (said._tag === "Success") return Effect.fail(refused(`${host.id}: ${said.success.error.message}`));
        }
        return Effect.fail(cause);
      }));
    const decoded = yield* Schema.decodeUnknownEffect(answer, { onExcessProperty: "error" })(result.stdout.trim().split("\n").at(-1)).pipe(
      Effect.mapError(() => refused(`${host.id} answered machine ${op} outside its contract`)));
    return decoded.data;
  });

  const setUp = Effect.fn("MachineLinkSetup.link")(function* (input: MachineLinkInput) {
    const self = { machineName: yield* machines.machineName, installationId: yield* machines.installationId };
    if (input.to === self.machineName) return yield* Effect.fail(refused("This machine dials out; no machine is given a route to it"));
    if (input.from === input.to) return yield* Effect.fail(refused("A machine does not link to itself"));
    const boat = new Set((yield* Effect.promise(() => readBoatRecords(options.home))).machines.map((row) => row.name));
    const end = (name: string) => Effect.gen(function* () {
      const host = yield* hosts.get(name);
      const pin = yield* machines.peer(name);
      if (host === undefined || pin === undefined || host.isThisMachine) return yield* Effect.fail(refused(`Set up ${name} from this machine before linking it`));
      if (boat.has(name)) return yield* Effect.fail(refused(`${name} is a Boat machine, whose address changes as it sleeps; it is not linked by key`));
      return { host, pin, ...(yield* resolve(host)) };
    });
    const to = yield* end(input.to);
    const from = input.from === self.machineName ? undefined : yield* end(input.from);
    // This machine's own keys first: their known hosts pin every setup session that follows.
    const keyFor = (peer: typeof to) => Effect.try({
      try: () => {
        const publicKey = makeLinkKey(options.home, peer.host.id, self.installationId, { replace: true });
        return { publicKey, knownHostsFile: writeLinkKnownHosts(options.home, peer.host.id, peer.route, peer.hostKeys) };
      },
      catch: (cause) => refused((cause as Error).message),
    });
    const ownTo = yield* keyFor(to);
    const ownFrom = from === undefined ? undefined : yield* keyFor(from);
    const fromKey = from === undefined || ownFrom === undefined ? undefined
      : yield* owner(from.host, ownFrom.knownHostsFile, "link-key", { peer: to.host.id, replace: true }, KeyData);
    if (from !== undefined && (fromKey?.installationId !== from.pin.installationId || fromKey.machineName !== from.host.id)) {
      return yield* Effect.fail(refused(`${input.from} answered as another installation`));
    }
    const accepted = yield* owner(to.host, ownTo.knownHostsFile, "link-accept", { openers: [
      ...(from === undefined || fromKey === undefined ? [] : [{ machineName: from.host.id, installationId: from.pin.installationId, publicKey: fromKey.publicKey }]),
      { ...self, publicKey: ownTo.publicKey },
    ] }, AcceptData);
    if (!accepted.pins.some((pin) => pin.installationId === self.installationId)) return yield* Effect.fail(refused(`${input.to} did not bind this machine's key`));
    if (from !== undefined && ownFrom !== undefined) yield* owner(from.host, ownFrom.knownHostsFile, "link-accept", { openers: [{ ...self, publicKey: ownFrom.publicKey }] }, AcceptData);
    // This machine dials both ends by key from now on; the links it held close and its keeper redials them bound.
    const routes: Array<MachineLinkRoute & { readonly from: string }> = [];
    for (const peer of from === undefined ? [to] : [to, from]) {
      yield* Effect.try({ try: () => writeBoundRoute(options.home, peer.host.id, peer.route), catch: (cause) => refused((cause as Error).message) });
      yield* link.disconnect(peer.host.id).pipe(Effect.ignore);
      routes.push({ from: self.machineName, ...peer.route });
    }
    if (from !== undefined && ownFrom !== undefined) {
      const reach = input.sshTarget === undefined ? to.route : yield* literalRoute(input.to, input.sshTarget, input.sshPort);
      yield* owner(from.host, ownFrom.knownHostsFile, "link-open", {
        name: to.host.id, installationId: to.pin.installationId, user: reach.user, host: reach.host, port: reach.port,
        hostKeys: to.hostKeys, juntoHome: to.host.juntoHome, installRoot: to.host.installRoot,
      }, OpenData);
      routes.unshift({ from: from.host.id, ...reach });
    }
    return { from: input.from, to: input.to, routes } satisfies MachineLinkData;
  });

  /** On the machine that will dial: a new key for links to `peer`. */
  const key = Effect.fn("MachineLinkSetup.key")(function* (input: MachineLinkKeyInput) {
    const self = { machineName: yield* machines.machineName, installationId: yield* machines.installationId };
    const publicKey = yield* Effect.try({
      try: () => makeLinkKey(options.home, input.peer, self.installationId, input.replace === true ? { replace: true } : {}),
      catch: (cause) => refused((cause as Error).message),
    });
    return { ...self, publicKey } satisfies MachineLinkKeyData;
  });

  /** On the machine that will receive: each opener pinned with its key, then its line written. */
  const accept = Effect.fn("MachineLinkSetup.accept")(function* (input: MachineLinkAcceptInput) {
    const juntoPath = options.juntoPath();
    if (juntoPath === undefined) return yield* Effect.fail(refused("This Junto runs from no installed package, so no link key can name it"));
    const pins: Array<MachineLinkAcceptData["pins"][number]> = [];
    for (const opener of input.openers) {
      // The line is built, and so checked, before anything is pinned.
      const line = yield* Effect.try({
        try: () => linkKeyLine({ juntoHome: options.home, juntoPath, opener: opener.installationId, publicKey: opener.publicKey }),
        catch: (cause) => refused((cause as Error).message),
      });
      const pin = yield* machines.pinPeer({ machineName: opener.machineName, installationId: opener.installationId }, { binding: "key" });
      yield* Effect.tryPromise({ try: () => editAuthorizedKeys((text) => upsertLinkLine(text, line), authorizedKeys), catch: (cause) => refused((cause as Error).message) });
      // A link it held without the key is closed; it comes back through the key.
      yield* link.disconnect(opener.machineName).pipe(Effect.ignore);
      pins.push({ machineName: pin.machineName, installationId: pin.installationId, boundAt: pin.boundAt });
    }
    return { pins } satisfies MachineLinkAcceptData;
  });

  /** On the machine that will dial: the route and host keys for `name`, then one dial that pins it from its checked hello. */
  const openLink = Effect.fn("MachineLinkSetup.open")(function* (input: MachineLinkOpenInput) {
    yield* Effect.try({
      try: () => {
        writeLinkKnownHosts(options.home, input.name, input, input.hostKeys);
        writeBoundRoute(options.home, input.name, input);
      },
      catch: (cause) => refused((cause as Error).message),
    });
    const previous = yield* hosts.get(input.name);
    const host: RemoteHost = previous ?? {
      id: input.name, label: input.name, isThisMachine: false, sshEndpoint: `${input.user}@${input.host}` as RemoteHost["sshEndpoint"],
      capabilities: ["terminal"], ...(input.port === 22 ? {} : { sshPort: input.port }),
    };
    const located: RemoteHost = { ...host, juntoHome: input.juntoHome, installRoot: input.installRoot };
    yield* hosts.upsert(located);
    const pin = yield* link.connectSetup(located, input.installationId);
    return { machineName: pin.machineName, installationId: pin.installationId, boundAt: pin.boundAt } satisfies MachineLinkOpenData;
  });

  /** On a machine that received links: that installation's line comes off. */
  const revoke = Effect.fn("MachineLinkSetup.revoke")(function* (input: MachineLinkRevokeInput) {
    const home = linkHomeTag(options.home);
    const before = yield* Effect.try({ try: () => readAuthorizedKeys(authorizedKeys), catch: (cause) => refused((cause as Error).message) });
    if (!hasLinkLine(before, home, input.installationId)) return { installationId: input.installationId, removed: false } satisfies MachineLinkRevokeData;
    yield* Effect.tryPromise({ try: () => editAuthorizedKeys((text) => removeLinkLines(text, home, input.installationId), authorizedKeys), catch: (cause) => refused((cause as Error).message) });
    return { installationId: input.installationId, removed: true } satisfies MachineLinkRevokeData;
  });

  /** A machine taken off this one: its key and route here, and its line here, both go. */
  const forget = (name: string, installationId: InstallationId) => Effect.gen(function* () {
    yield* Effect.sync(() => removeLinkKey(options.home, name));
    yield* revoke({ installationId }).pipe(Effect.ignore);
  });

  /** Does that key-bound peer still have its line here: a missing one is drift, repaired by linking again. */
  const lineHeld = (installationId: InstallationId): boolean => {
    try { return hasLinkLine(readAuthorizedKeys(authorizedKeys), linkHomeTag(options.home), installationId); }
    catch { return false; }
  };

  /**
   * A removed machine's key comes off every machine this one reaches, over the
   * route it keeps for each: strict against the bound known hosts when this
   * machine keyed it, the operator's route otherwise. One it cannot reach is
   * kept as still holding that key, and tried again at the next removal.
   */
  const revokeEverywhere = (removed?: { readonly machineName: string; readonly installationId: InstallationId }) => Effect.gen(function* () {
    const pending = [...readPending(options.home), ...(removed === undefined ? [] : (yield* machines.peers)
      .filter((peer) => peer.machineName !== removed.machineName)
      .map((peer) => ({ holder: peer.machineName, ...removed })))];
    // A Boat machine is never keyed, so it holds no line.
    const boat = new Set((yield* Effect.promise(() => readBoatRecords(options.home))).machines.map((row) => row.name));
    const still: Array<PendingRevocation> = [];
    for (const row of pending) {
      const host = yield* hosts.get(row.holder);
      if (host === undefined || boat.has(row.holder) || (yield* machines.peer(row.holder)) === undefined) continue;
      const known = readBoundRoute(options.home, row.holder)?.knownHostsFile ?? host.sshKnownHostsFile;
      const revoked = yield* ownerWith(host, known, "link-revoke", { installationId: row.installationId }, RevokeData).pipe(Effect.option);
      if (revoked._tag === "None") still.push(row);
    }
    yield* Effect.sync(() => writePending(options.home, still));
    return still;
  });

  return {
    link: (input: MachineLinkInput) => setUp(input).pipe(Effect.tap(() => revokeEverywhere().pipe(Effect.ignore))),
    key, accept, open: openLink, revoke, forget, lineHeld, revokeEverywhere,
    /** Removed machines whose key each holder may still hold. */
    pending: () => readPending(options.home),
  };
});

export type MachineLinkSetup = Effect.Success<ReturnType<typeof makeMachineLinkSetup>>;

/** A removed machine's key a holder could not be reached to remove. */
interface PendingRevocation {
  readonly holder: string;
  readonly machineName: string;
  readonly installationId: InstallationId;
}

const pendingFile = (home: string) => join(home, ".junto", "core", "link-keys", "unrevoked.json");
const readPending = (home: string): ReadonlyArray<PendingRevocation> => {
  try {
    const rows = JSON.parse(readFileSync(pendingFile(home), "utf8")) as unknown;
    return Array.isArray(rows) ? rows.filter((row): row is PendingRevocation =>
      typeof row === "object" && row !== null && typeof row.holder === "string" && typeof row.machineName === "string" && typeof row.installationId === "string") : [];
  } catch { return []; }
};
const writePending = (home: string, rows: ReadonlyArray<PendingRevocation>): void => {
  const file = pendingFile(home);
  if (rows.length === 0) { rmSync(file, { force: true }); return; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.junto-new`, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  renameSync(`${file}.junto-new`, file);
};

/** `user@host` as `from` reaches `to`: literal, since a bound link reads no config. */
const literalRoute = (machine: string, target: string, port: number | undefined) => Effect.gen(function* () {
  const at = target.indexOf("@");
  const route = { machine, user: target.slice(0, at), host: target.slice(at + 1), port: port ?? 22 };
  if (at <= 0 || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(route.user) || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(route.host)) {
    return yield* Effect.fail(refused("The route to dial is one literal user@host: a bound link reads no SSH config"));
  }
  return route;
});
