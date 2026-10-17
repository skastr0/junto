/**
 * The last inventory snapshot each linked machine sent, kept by the editing
 * machine so a machine it cannot reach still shows what it had, and how old
 * that is. One file per peer, named from the pinned peer's machine name
 * (checked before any path is built), never from the payload. The directory
 * is 0700 and each file 0600, written temp-then-rename. A file is decoded
 * with the same closed schema on read; one that fails is a typed refusal and
 * is never shown.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { resolveJuntoHome } from "@shared/junto-home";
import { isValidMachineName } from "@shared/machine-identity";
import { decodeLinkInventorySnapshot, type LinkInventorySnapshot } from "./wire";

const FILE_VERSION = 1;

export const peerInventoryDir = (): string => join(resolveJuntoHome(), ".junto", "state", "peer-inventory");

export type StoredPeerInventory = {
  readonly snapshot: LinkInventorySnapshot;
  /** When this machine received it. */
  readonly receivedAt: number;
};

/** The stored file for a peer could not be read as a snapshot; it is not shown. */
export class PeerInventoryFileRefused extends Schema.TaggedError<PeerInventoryFileRefused>()("PeerInventoryFileRefused", {
  machine: Schema.String,
  message: Schema.String,
}) {}

/** The peer name is not a machine name, so no path is built from it. */
export class PeerInventoryNameRefused extends Schema.TaggedError<PeerInventoryNameRefused>()("PeerInventoryNameRefused", {
  machine: Schema.String,
  message: Schema.String,
}) {}

const fileOf = (dir: string, machine: string): Effect.Effect<string, PeerInventoryNameRefused> =>
  isValidMachineName(machine)
    ? Effect.succeed(join(dir, `${machine}.json`))
    : Effect.fail(new PeerInventoryNameRefused({ machine: machine.slice(0, 64), message: "That is not a machine name." }));

const StoredFile = Schema.Struct({
  version: Schema.Literal(FILE_VERSION),
  receivedAt: Schema.Finite,
  snapshot: Schema.Unknown,
});
const decodeStored = Schema.decodeUnknownSync(StoredFile, { onExcessProperty: "error" });

export const makePeerInventoryCache = (dir: string = peerInventoryDir()) => {
  const write = (peer: string, stored: StoredPeerInventory) => Effect.gen(function* () {
    const path = yield* fileOf(dir, peer);
    const text = `${JSON.stringify({ version: FILE_VERSION, receivedAt: stored.receivedAt, snapshot: stored.snapshot })}\n`;
    const temp = `${path}.${process.pid}.tmp`;
    yield* Effect.tryPromise(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    });
  });

  /** The peer's last snapshot; undefined when none was ever stored. */
  const read = (peer: string) => Effect.gen(function* () {
    const path = yield* fileOf(dir, peer);
    const text = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.option);
    if (text._tag === "None") return undefined;
    return yield* Effect.try({
      try: (): StoredPeerInventory => {
        const stored = decodeStored(JSON.parse(text.value));
        const snapshot = decodeLinkInventorySnapshot(stored.snapshot);
        if (snapshot.machine !== peer) throw new Error(`it names ${snapshot.machine.slice(0, 64)}`);
        return { snapshot, receivedAt: stored.receivedAt };
      },
      catch: (cause) => new PeerInventoryFileRefused({
        machine: peer,
        message: `The stored inventory for ${peer} is not a valid snapshot (${cause instanceof Error ? cause.message.slice(0, 200) : "unreadable"}).`,
      }),
    });
  });

  return { read, write };
};

export type PeerInventoryCache = ReturnType<typeof makePeerInventoryCache>;
