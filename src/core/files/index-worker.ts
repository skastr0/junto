import { parentPort } from "node:worker_threads";
import { serveRootIndex } from "./root-index-port";

/**
 * The Files root index, off main's loop: watchers, walks, git output,
 * builds, deltas and searches (see `root-index.ts`). Git itself is spawned
 * by main on the process plane.
 */
if (parentPort === null) throw new Error("the files index runs as a worker thread");
serveRootIndex(parentPort);
