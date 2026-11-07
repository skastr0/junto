/**
 * Every group main serves the core, merged: main's one host server answers
 * this (`src/app/core-process/host-server.ts`), and `hostClient` accepts only
 * a group in it. A group joins here with its handlers in main's server and
 * its client in the core's (`src/core/host-clients.ts`).
 */
import { RpcGroup } from "effect/rpc";
import { ClipboardHostRpcs } from "./clipboard";
import { FilesHostRpcs } from "./files";
import { OverseerPagesHostRpcs } from "./overseer-pages";
import { WindowHostRpcs } from "./window";

export const HostRpcs = RpcGroup.make().merge(ClipboardHostRpcs, FilesHostRpcs, OverseerPagesHostRpcs, WindowHostRpcs);
