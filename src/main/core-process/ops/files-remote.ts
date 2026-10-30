import { Effect } from "effect";
import type {
  FileEntry, FilePath, FileRead, FilesCount, FilesNodeRef, FilesResult, FilesRoot, FilesSearchResult, FileStamp,
} from "@shared/files";
import type { FilesRemote, RemoteChange } from "../../junto/files/link-client";
import { heldFilesRemote } from "../../junto/files/remote-holder";
import type { FilesRemotePort } from "../../junto/files/router";
import { coreOps, type CoreOp } from "../ops";

/**
 * Files over SSH (X2): the link runs in the core and the Files router in main,
 * so main asks the core's link client by name, and its changes ride the push.
 */

type On = { readonly machine: string; readonly ref: FilesNodeRef };
type AtPath = On & { readonly path: FilePath };

declare module "../ops" {
  interface CoreOps {
    "files.remote.open": CoreOp<On, FilesResult<FilesRoot>>;
    "files.remote.close": CoreOp<On, FilesResult<null>>;
    "files.remote.count": CoreOp<On, FilesResult<FilesCount>>;
    "files.remote.list": CoreOp<On & { readonly dir: FilePath }, FilesResult<ReadonlyArray<FileEntry>>>;
    "files.remote.read": CoreOp<AtPath, FilesResult<FileRead>>;
    "files.remote.write": CoreOp<AtPath & { readonly text: string; readonly base: FileStamp | null }, FilesResult<FileStamp>>;
    "files.remote.create": CoreOp<AtPath & { readonly dir: boolean }, FilesResult<FileEntry>>;
    "files.remote.rename": CoreOp<AtPath & { readonly name: string }, FilesResult<FilePath>>;
    "files.remote.move": CoreOp<AtPath & { readonly into: FilePath }, FilesResult<FilePath>>;
    "files.remote.trash": CoreOp<AtPath, FilesResult<null>>;
    "files.remote.search": CoreOp<On & { readonly query: string; readonly seq: number }, FilesResult<FilesSearchResult>>;
  }
}

const failed = { ok: false, error: "failed" } as const;

/** Never fails: with no link client (the feature off) or a call that threw, the answer is `failed`. */
const held = <A>(use: (remote: FilesRemote) => Promise<FilesResult<A>>): Effect.Effect<FilesResult<A>> =>
  Effect.promise(async () => {
    const remote = heldFilesRemote();
    return remote === undefined ? failed : use(remote).catch(() => failed);
  });

coreOps({
  "files.remote.open": ({ machine, ref }) => held((remote) => remote.open(machine, ref)),
  "files.remote.close": ({ machine, ref }) => held((remote) => remote.close(machine, ref)),
  "files.remote.count": ({ machine, ref }) => held((remote) => remote.count(machine, ref)),
  "files.remote.list": ({ machine, ref, dir }) => held((remote) => remote.list(machine, ref, dir)),
  "files.remote.read": ({ machine, ref, path }) => held((remote) => remote.read(machine, ref, path)),
  "files.remote.write": ({ machine, ref, path, text, base }) => held((remote) => remote.write(machine, ref, path, text, base)),
  "files.remote.create": ({ machine, ref, path, dir }) => held((remote) => remote.create(machine, ref, path, dir)),
  "files.remote.rename": ({ machine, ref, path, name }) => held((remote) => remote.rename(machine, ref, path, name)),
  "files.remote.move": ({ machine, ref, path, into }) => held((remote) => remote.move(machine, ref, path, into)),
  "files.remote.trash": ({ machine, ref, path }) => held((remote) => remote.trash(machine, ref, path)),
  "files.remote.search": ({ machine, ref, query, seq }) => held((remote) => remote.search(machine, ref, query, seq)),
});
