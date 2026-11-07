import type { Worker } from "node:worker_threads";
import type { Message } from "@shared/work-model";
import createMailReadWorker from "./mail-read-worker?nodeWorker";
import type { MailPage, MailPageQuery, SentMail } from "./mail-read-sql";

/**
 * Main's side of the mail read worker (`mail-read-worker.ts`): a seat's
 * mailbox and its sent mail, whole or one page, read off main's loop from junto.db's last
 * commit. The worker starts on the first read and is unref'd, so it never
 * holds the process open.
 *
 * A read that cannot be answered there rejects, and the caller reads on main
 * instead: the answer is the same, only where it runs differs. That covers a
 * runtime with no worker entry (vitest loads `?nodeWorker` as a plain
 * module), a worker that stopped, and one that cannot open the file. A
 * worker that stops is started again on the next read, but not sooner than
 * 1 s after it stopped, doubling to 30 s while it keeps stopping.
 */

export type MailReadWorkerData = { readonly path: string };

type MailReadTarget = {
  readonly id: number;
  readonly canvasName: string;
  /** The mailbox for an inbox read, the sender for a sent read. */
  readonly nodeId: string;
};

export type MailReadRequest =
  | (MailReadTarget & { readonly read: "inbox" })
  | (MailReadTarget & { readonly read: "sentBy" })
  | (MailReadTarget & { readonly read: "inboxPage"; readonly page: MailPageQuery })
  | (MailReadTarget & { readonly read: "sentByPage"; readonly page: MailPageQuery });

/** A request before the host numbers it. */
type Unnumbered<T> = T extends unknown ? Omit<T, "id"> : never;

export type MailReadAnswer =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

export type MailReads = {
  readonly inbox: (canvasName: string, nodeId: string) => Promise<ReadonlyArray<Message>>;
  readonly sentBy: (canvasName: string, sender: string) => Promise<ReadonlyArray<SentMail>>;
  readonly inboxPage: (canvasName: string, nodeId: string, page: MailPageQuery) => Promise<MailPage<Message>>;
  readonly sentByPage: (canvasName: string, sender: string, page: MailPageQuery) => Promise<MailPage<SentMail>>;
};

/** A read the worker has not answered by then falls back to main. */
const READ_TIMEOUT_MS = 30_000;
const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** A worker that lived this long resets the backoff. */
const RESTART_SETTLED_MS = 60_000;

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export const workerMailReads = (path: string): MailReads => {
  let current: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let stops = 0;
  let startedAt = 0;
  let notBefore = 0;

  const failAll = (cause: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(cause);
    }
  };

  const stopped = (worker: Worker, cause: Error): void => {
    if (current !== worker) return;
    current = undefined;
    if (Date.now() - startedAt > RESTART_SETTLED_MS) stops = 0;
    notBefore = Date.now() + Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** stops);
    stops += 1;
    failAll(cause);
  };

  const live = (): Worker => {
    if (current !== undefined) return current;
    if (typeof createMailReadWorker !== "function") throw new Error("no mail read worker in this runtime");
    if (Date.now() < notBefore) throw new Error("the mail read worker is restarting");
    const workerData: MailReadWorkerData = { path };
    const worker = createMailReadWorker({ name: "junto-mail-reads", workerData });
    worker.unref();
    worker.on("message", (answer: MailReadAnswer) => {
      const entry = pending.get(answer.id);
      if (entry === undefined) return;
      pending.delete(answer.id);
      clearTimeout(entry.timer);
      if (answer.ok) entry.resolve(answer.value);
      else entry.reject(new Error(answer.error));
    });
    worker.on("error", (error: unknown) => stopped(worker, error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => stopped(worker, new Error(`the mail read worker exited with code ${code}`)));
    current = worker;
    startedAt = Date.now();
    return worker;
  };

  const ask = (request: Unnumbered<MailReadRequest>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = live();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the mail read worker did not answer in ${READ_TIMEOUT_MS} ms`));
      }, READ_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...request, id } as MailReadRequest);
    });

  return {
    inbox: (canvasName, nodeId) => ask({ read: "inbox", canvasName, nodeId }) as Promise<ReadonlyArray<Message>>,
    sentBy: (canvasName, sender) => ask({ read: "sentBy", canvasName, nodeId: sender }) as Promise<ReadonlyArray<SentMail>>,
    inboxPage: (canvasName, nodeId, page) =>
      ask({ read: "inboxPage", canvasName, nodeId, page }) as Promise<MailPage<Message>>,
    sentByPage: (canvasName, sender, page) =>
      ask({ read: "sentByPage", canvasName, nodeId: sender, page }) as Promise<MailPage<SentMail>>,
  };
};
