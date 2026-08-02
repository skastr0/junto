/**
 * Station content transfer orchestration.
 *
 * Command Center opens a separate SSH transfer channel (not Station NDJSON)
 * against the fixed packaged content helper.  Push and pull both:
 *   1) stat remote/local for resume offset
 *   2) stream only remaining bytes
 *   3) verify digest + length on the receiver
 *   4) publish atomically and record a transfer + content receipt
 *
 * Remotes never initiate connections to Command Center.
 */

import { Context, Effect, Fiber, Layer, Stream } from "effect";
import type { ContentRef } from "@shared/content";
import { resolveVellumHome } from "@shared/vellum-home";
import type { SshError, SshTarget } from "../ssh/domain";
import { SshInputError } from "../ssh/domain";
import { dedicatedStream, oneShot } from "../ssh/program";
import {
  resolveRemoteContentHelper,
  type RemotePackagedPlatform,
} from "../ssh/read-commands";
import {
  SshTransport,
  SshTransferExitError,
  type SshCommandResult,
} from "../ssh/service";
import {
  StateEngine,
  type StateEngineError,
} from "../state/service";
import {
  recordContentObject,
  upsertContentTransfer,
  type ContentTransferRow,
} from "./manifest";
import { contentStoreRoot } from "./paths";
import { ContentStoreError } from "./store";
import { contentHelperArgv } from "./helper-contract";
import {
  receiveContentTransfer,
  sendContentTransfer,
  statContentForTransfer,
  parseContentHelperStatus,
  type ContentHelperStatusLine,
  type ContentReceiveResult,
} from "./transfer-local";

const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;

export type ContentTransferPeer = {
  readonly target: SshTarget;
  readonly platform: RemotePackagedPlatform;
  readonly installationId?: string;
};

export type ContentTransferOutcome = {
  readonly transfer: ContentTransferRow;
  readonly receipt?: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly verifiedAt: string;
  };
  readonly resumedFrom: number;
  readonly idempotent: boolean;
};

export type ContentTransferServiceError =
  | ContentStoreError
  | StateEngineError
  | SshError
  | SshInputError
  | SshTransferExitError
  | ContentTransferError;

export class ContentTransferError extends Error {
  readonly _tag = "ContentTransferError";
  constructor(
    readonly code:
      | "remote-status"
      | "remote-failed"
      | "local-missing"
      | "corrupt"
      | "incomplete",
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ContentTransferError";
  }
}

type StateService = Context.Tag.Service<typeof StateEngine>;
type SshService = Context.Tag.Service<typeof SshTransport>;

const transferIdFor = (
  direction: "inbound" | "outbound",
  sha256: string,
  peerInstallationId: string | undefined,
): string => {
  const peer = peerInstallationId ?? "unknown";
  return `xfer_${direction}_${sha256.slice(0, 24)}_${peer}`.slice(0, 256);
};

const statusFromStdout = (
  result: SshCommandResult,
): ContentHelperStatusLine => {
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? "";
  return parseContentHelperStatus(last);
};

const assertVerifiedStatus = (
  status: ContentHelperStatusLine,
  ref: ContentRef,
): { readonly verifiedAt: string } => {
  if (!status.ok) {
    throw new ContentTransferError(
      "remote-failed",
      status.error || "remote content helper failed",
    );
  }
  if (status.state === "partial") {
    throw new ContentTransferError(
      "incomplete",
      `remote content transfer incomplete at ${status.receivedBytes}/${status.byteLength}`,
    );
  }
  if (status.state !== "verified") {
    throw new ContentTransferError(
      "remote-status",
      `remote content helper returned state ${status.state}`,
    );
  }
  if (
    status.sha256 !== ref.sha256 ||
    status.byteLength !== ref.byteLength
  ) {
    throw new ContentTransferError(
      "corrupt",
      "remote content receipt does not match ContentRef",
    );
  }
  return { verifiedAt: status.verifiedAt };
};

/**
 * Bridge an Effect Stream into an AsyncIterable without holding the full
 * payload.  A small in-flight queue bounds memory to stream backpressure.
 */
const streamAsAsyncIterable = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  onError: (error: E) => Error,
): {
  readonly iterable: AsyncIterable<Uint8Array>;
  readonly run: Effect.Effect<void, E>;
} => {
  const queue: Uint8Array[] = [];
  let done = false;
  let failed: Error | undefined;
  let wake: (() => void) | undefined;

  const signal = (): void => {
    const waiter = wake;
    wake = undefined;
    waiter?.();
  };

  const run = Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      queue.push(chunk);
      signal();
    }),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        done = true;
        signal();
      }),
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        failed = onError(error);
        done = true;
        signal();
      }),
    ),
  );

  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (queue.length === 0 && !done) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false as const };
        }
        if (failed !== undefined) throw failed;
        return { value: undefined, done: true as const };
      },
    }),
  };

  return { iterable, run };
};

export class ContentTransferService extends Context.Tag(
  "@vellum/ContentTransferService",
)<
  ContentTransferService,
  {
    readonly root: string;
    /**
     * Push a local verified object to a Remote.  Idempotent when the Remote
     * already holds a verified digest.  Resumes from the remote partial size.
     */
    readonly push: (
      ref: ContentRef,
      peer: ContentTransferPeer,
    ) => Effect.Effect<ContentTransferOutcome, ContentTransferServiceError>;
    /**
     * Pull a Remote object into the local content store.  Idempotent when the
     * local object is already verified.  Resumes from the local partial size.
     */
    readonly pull: (
      ref: ContentRef,
      peer: ContentTransferPeer,
    ) => Effect.Effect<ContentTransferOutcome, ContentTransferServiceError>;
    /** Local-only receive path used by the fixed content helper. */
    readonly receiveLocal: (
      ref: ContentRef,
      source: AsyncIterable<Uint8Array | Buffer> | Uint8Array | Buffer,
      expectedOffset?: number,
    ) => Effect.Effect<
      ContentReceiveResult,
      ContentStoreError | StateEngineError
    >;
  }
>() {}

const makeContentTransferService = (
  state: StateService,
  ssh: SshService,
  root: string,
): Context.Tag.Service<typeof ContentTransferService> => ({
  root,

  receiveLocal: (ref, source, expectedOffset) =>
    Effect.gen(function* () {
      const received = yield* Effect.tryPromise({
        try: () =>
          receiveContentTransfer({
            root,
            ref,
            source,
            expectedOffset,
          }),
        catch: (cause) => {
          if (cause instanceof ContentStoreError) return cause;
          return new ContentStoreError(
            "io",
            cause instanceof Error ? cause.message : String(cause),
            { cause },
          );
        },
      });

      if (received.state === "verified") {
        yield* state.transaction("content.transfer.receiveLocal", (writer) => {
          recordContentObject(writer, {
            sha256: received.ref.sha256,
            byteLength: received.ref.byteLength,
            verifiedAt: received.verifiedAt,
          });
          upsertContentTransfer(writer, {
            transferId: transferIdFor(
              "inbound",
              received.ref.sha256,
              "local-helper",
            ),
            sha256: received.ref.sha256,
            byteLength: received.ref.byteLength,
            state: "complete",
            direction: "inbound",
            peerInstallationId: "local-helper",
          });
        });
      }
      return received;
    }),

  push: (ref, peer) =>
    Effect.gen(function* () {
      const local = statContentForTransfer(root, ref);
      if (local.state !== "verified") {
        return yield* Effect.fail(
          new ContentTransferError(
            "local-missing",
            "local content object is not verified for push",
          ),
        );
      }

      const transferId = transferIdFor(
        "outbound",
        ref.sha256,
        peer.installationId,
      );

      yield* state.transaction("content.transfer.push.pending", (writer) =>
        upsertContentTransfer(writer, {
          transferId,
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          state: "pending",
          direction: "outbound",
          peerInstallationId: peer.installationId,
        }),
      );

      // 1) Stat remote for resume / idempotent complete.
      const statCmd = yield* resolveRemoteContentHelper(
        ssh,
        peer.target,
        peer.platform,
        contentHelperArgv({
          mode: "stat",
          sha256: ref.sha256,
          byteLength: ref.byteLength,
        }),
      );
      const statResult = yield* ssh.run(oneShot(peer.target, statCmd));
      const remoteStat = statusFromStdout(statResult);

      if (
        remoteStat.ok &&
        remoteStat.state === "verified" &&
        remoteStat.sha256 === ref.sha256 &&
        remoteStat.byteLength === ref.byteLength
      ) {
        const transfer = yield* state.transaction(
          "content.transfer.push.idempotent",
          (writer) =>
            upsertContentTransfer(writer, {
              transferId,
              sha256: ref.sha256,
              byteLength: ref.byteLength,
              state: "complete",
              direction: "outbound",
              peerInstallationId: peer.installationId,
            }),
        );
        return {
          transfer,
          receipt: {
            sha256: remoteStat.sha256,
            byteLength: remoteStat.byteLength,
            verifiedAt: remoteStat.verifiedAt,
          },
          resumedFrom: ref.byteLength,
          idempotent: true,
        } satisfies ContentTransferOutcome;
      }

      let offset = 0;
      if (
        remoteStat.ok &&
        remoteStat.state === "partial" &&
        remoteStat.sha256 === ref.sha256
      ) {
        offset = remoteStat.receivedBytes;
      }

      yield* state.transaction("content.transfer.push.receiving", (writer) =>
        upsertContentTransfer(writer, {
          transferId,
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          state: "receiving",
          direction: "outbound",
          peerInstallationId: peer.installationId,
        }),
      );

      const receiveCmd = yield* resolveRemoteContentHelper(
        ssh,
        peer.target,
        peer.platform,
        contentHelperArgv({
          mode: "receive",
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          offset,
        }),
      );

      const byteStream = Stream.fromAsyncIterable(
        sendContentTransfer({ root, ref, offset }),
        (error) =>
          error instanceof ContentStoreError
            ? error
            : new ContentStoreError(
                "io",
                error instanceof Error ? error.message : String(error),
                { cause: error },
              ),
      ).pipe(Stream.map((chunk) => Uint8Array.from(chunk)));

      const transferResult = yield* ssh.transfer(
        dedicatedStream(peer.target, receiveCmd, "agent"),
        byteStream,
        TRANSFER_TIMEOUT_MS,
      );

      let verified: { readonly verifiedAt: string };
      try {
        verified = assertVerifiedStatus(statusFromStdout(transferResult), ref);
      } catch (error) {
        yield* state.transaction("content.transfer.push.failed", (writer) =>
          upsertContentTransfer(writer, {
            transferId,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            state: "failed",
            direction: "outbound",
            peerInstallationId: peer.installationId,
            errorReason:
              error instanceof Error
                ? error.message.slice(0, 1024)
                : "push failed",
          }),
        );
        return yield* Effect.fail(
          error instanceof ContentTransferError
            ? error
            : new ContentTransferError(
                "remote-failed",
                error instanceof Error ? error.message : String(error),
                { cause: error },
              ),
        );
      }

      const transfer = yield* state.transaction(
        "content.transfer.push.complete",
        (writer) =>
          upsertContentTransfer(writer, {
            transferId,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            state: "complete",
            direction: "outbound",
            peerInstallationId: peer.installationId,
          }),
      );

      return {
        transfer,
        receipt: {
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          verifiedAt: verified.verifiedAt,
        },
        resumedFrom: offset,
        idempotent: false,
      } satisfies ContentTransferOutcome;
    }),

  pull: (ref, peer) =>
    Effect.gen(function* () {
      const transferId = transferIdFor(
        "inbound",
        ref.sha256,
        peer.installationId,
      );

      const local = statContentForTransfer(root, ref);
      if (local.state === "verified") {
        const transfer = yield* state.transaction(
          "content.transfer.pull.idempotent",
          (writer) => {
            recordContentObject(writer, {
              sha256: ref.sha256,
              byteLength: ref.byteLength,
              verifiedAt: local.verifiedAt,
            });
            return upsertContentTransfer(writer, {
              transferId,
              sha256: ref.sha256,
              byteLength: ref.byteLength,
              state: "complete",
              direction: "inbound",
              peerInstallationId: peer.installationId,
            });
          },
        );
        return {
          transfer,
          receipt: {
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            verifiedAt: local.verifiedAt,
          },
          resumedFrom: ref.byteLength,
          idempotent: true,
        } satisfies ContentTransferOutcome;
      }

      const offset = local.state === "partial" ? local.partialBytes : 0;

      yield* state.transaction("content.transfer.pull.receiving", (writer) =>
        upsertContentTransfer(writer, {
          transferId,
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          state: "receiving",
          direction: "inbound",
          peerInstallationId: peer.installationId,
        }),
      );

      const sendCmd = yield* resolveRemoteContentHelper(
        ssh,
        peer.target,
        peer.platform,
        contentHelperArgv({
          mode: "send",
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          offset,
        }),
      );

      const received = yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* ssh.connect(
            dedicatedStream(peer.target, sendCmd, "agent"),
            (handle, confirm) => Effect.succeed(confirm(handle)),
          );

          const bridged = streamAsAsyncIterable(lease.stdout, (error) =>
            error instanceof Error
              ? error
              : new Error(String(error)),
          );
          // S5 Effect V4 prep (effect@3.21): Effect.fork → Effect.forkChild on V4 bump.
          // See Playground/effect/migration/forking.md. Sole product Effect.fork site
          // under src/main (2026-04 inventory); forkDaemon: none; forkScoped/forkIn unchanged.
          const runner = yield* Effect.fork(bridged.run);

          const result = yield* Effect.tryPromise({
            try: () =>
              receiveContentTransfer({
                root,
                ref,
                source: bridged.iterable,
                expectedOffset: offset,
              }),
            catch: (cause) => {
              if (cause instanceof ContentStoreError) return cause;
              return new ContentStoreError(
                "io",
                cause instanceof Error ? cause.message : String(cause),
                { cause },
              );
            },
          });

          yield* Fiber.join(runner);
          yield* lease.closeInput;
          const exit = yield* lease.exitCode;
          if (exit !== 0 && result.state !== "verified") {
            return yield* Effect.fail(
              new ContentTransferError(
                "remote-failed",
                `remote content send exited ${exit}`,
              ),
            );
          }
          return result;
        }),
      );

      if (received.state !== "verified") {
        yield* state.transaction("content.transfer.pull.partial", (writer) =>
          upsertContentTransfer(writer, {
            transferId,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            state: "receiving",
            direction: "inbound",
            peerInstallationId: peer.installationId,
            errorReason: `partial ${received.receivedBytes}/${ref.byteLength}`,
          }),
        );
        return yield* Effect.fail(
          new ContentTransferError(
            "incomplete",
            `local content transfer incomplete at ${received.receivedBytes}/${ref.byteLength}`,
          ),
        );
      }

      const transfer = yield* state.transaction(
        "content.transfer.pull.complete",
        (writer) => {
          recordContentObject(writer, {
            sha256: received.ref.sha256,
            byteLength: received.ref.byteLength,
            verifiedAt: received.verifiedAt,
          });
          return upsertContentTransfer(writer, {
            transferId,
            sha256: received.ref.sha256,
            byteLength: received.ref.byteLength,
            state: "complete",
            direction: "inbound",
            peerInstallationId: peer.installationId,
          });
        },
      );

      return {
        transfer,
        receipt: {
          sha256: received.ref.sha256,
          byteLength: received.ref.byteLength,
          verifiedAt: received.verifiedAt,
        },
        resumedFrom: offset,
        idempotent: false,
      } satisfies ContentTransferOutcome;
    }),
});

export const makeContentTransferServiceLive = (options?: {
  readonly home?: string;
  readonly root?: string;
}): Layer.Layer<
  ContentTransferService,
  never,
  StateEngine | SshTransport
> =>
  Layer.effect(
    ContentTransferService,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const ssh = yield* SshTransport;
      const root =
        options?.root ??
        contentStoreRoot(options?.home ?? resolveVellumHome());
      return makeContentTransferService(state, ssh, root);
    }),
  );

/** Test helper against already-open deps. */
export const createContentTransferService = (
  state: StateService,
  ssh: SshService,
  root: string,
): Context.Tag.Service<typeof ContentTransferService> =>
  makeContentTransferService(state, ssh, root);

export {
  contentRefForTransfer,
  receiveContentTransfer,
  sendContentTransfer,
  statContentForTransfer,
  parseContentHelperStatus,
  encodeContentHelperStatus,
} from "./transfer-local";
