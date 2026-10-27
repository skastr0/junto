import { parentPort } from "node:worker_threads";
import { serveIndex } from "./index-engine";

/** The Files name index, off main's loop: builds, deltas and searches (see `index-engine.ts`). */
if (parentPort === null) throw new Error("the files index runs as a worker thread");
serveIndex(parentPort);
