/**
 * Main's side of Files over SSH (X2): the link runs in the core and the Files
 * router in main, so main asks the core's link client by name, and its
 * changes come back on the push bus.
 */
import type { FilesResult } from "@shared/files";
import type { RemoteChange } from "../../junto/files/link-client";
import type { FilesRemotePort } from "../../junto/files/router";
import { FILES_REMOTE_CHANGED } from "../channels";
import type { CoreClient } from "../client";
import { subscribe } from "../push";

const failed = { ok: false, error: "failed" } as const;

/** Main's link client: the router's port, answered by the core. A call the core could not take is `failed`. */
export const coreFilesRemote = (core: Pick<CoreClient, "call">): FilesRemotePort => {
  const ask = <A>(call: Promise<FilesResult<A>>): Promise<FilesResult<A>> => call.catch(() => failed);
  return {
    open: (machine, ref) => ask(core.call("files.remote.open", { machine, ref })),
    close: (machine, ref) => ask(core.call("files.remote.close", { machine, ref })),
    count: (machine, ref) => ask(core.call("files.remote.count", { machine, ref })),
    list: (machine, ref, dir) => ask(core.call("files.remote.list", { machine, ref, dir })),
    read: (machine, ref, path) => ask(core.call("files.remote.read", { machine, ref, path })),
    write: (machine, ref, path, text, base) => ask(core.call("files.remote.write", { machine, ref, path, text, base })),
    create: (machine, ref, path, dir) => ask(core.call("files.remote.create", { machine, ref, path, dir })),
    rename: (machine, ref, path, name) => ask(core.call("files.remote.rename", { machine, ref, path, name })),
    move: (machine, ref, path, into) => ask(core.call("files.remote.move", { machine, ref, path, into })),
    trash: (machine, ref, path) => ask(core.call("files.remote.trash", { machine, ref, path })),
    search: (machine, ref, query, seq) => ask(core.call("files.remote.search", { machine, ref, query, seq })),
    onChange: (listener) => subscribe(FILES_REMOTE_CHANGED, (change) => listener(change as RemoteChange)),
  };
};
