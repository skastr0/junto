/**
 * The mail read worker: a read-only connection to junto.db on its own thread,
 * answering the reads in `mail-read-sql.ts`. The database is WAL, so each
 * read sees the last commit while main keeps writing. The connection opens
 * on the first request and stays open for the worker's life.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { readInbox, readInboxPage, readSentBy, readSentByPage } from "./mail-read-sql";
import type { MailReadAnswer, MailReadRequest, MailReadWorkerData } from "./mail-read-host";

const serve = (port: NonNullable<typeof parentPort>): void => {
  const { path } = workerData as MailReadWorkerData;
  let database: DatabaseSync | undefined;
  const open = (): DatabaseSync => {
    database ??= new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 2_000,
    });
    return database;
  };
  port.on("message", (request: MailReadRequest) => {
    let answer: MailReadAnswer;
    try {
      const database = open();
      const value = request.read === "inbox"
        ? readInbox(database, request.canvasName, request.nodeId)
        : request.read === "sentBy"
          ? readSentBy(database, request.canvasName, request.nodeId)
          : request.read === "inboxPage"
            ? readInboxPage(database, request.canvasName, request.nodeId, request.page)
            : readSentByPage(database, request.canvasName, request.nodeId, request.page);
      answer = { id: request.id, ok: true, value };
    } catch (error) {
      answer = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(answer);
  });
};

// Loaded on a thread that is not a worker (vitest resolves `?nodeWorker` to
// this module), it serves nothing, and the host reads on main.
if (parentPort !== null) serve(parentPort);
