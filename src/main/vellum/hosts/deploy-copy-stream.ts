/**
 * Count payload bytes on a Deploy copy stream and publish them to the
 * active job. Completion means local stdin ended; the Remote may still unpack.
 */
import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Stream } from "effect";
import type { HostDeployCopyProgress } from "../../../shared/deploy-job";
import { reportDeployCopyProgress } from "./deploy-job-registry";

export const estimateDirectoryBytes = (root: string): number => {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (entry.isFile()) total += lstatSync(path).size;
      } catch {
        // skip unreadable entries — estimate, not admission
      }
    }
  };
  walk(root);
  return Math.max(total, 1);
};

const countCopyChunks = async function* (
  source: AsyncIterable<Uint8Array>,
  bytesTotal: number,
  hostId: string | undefined,
): AsyncGenerator<Uint8Array, void, unknown> {
  const startedAt = new Date().toISOString();
  const total = Math.max(1, bytesTotal);
  let sent = 0;
  const report = (copy: HostDeployCopyProgress): void => {
    if (hostId === undefined) return;
    reportDeployCopyProgress(hostId, copy);
  };
  report({
    bytesSent: 0,
    bytesTotal: total,
    startedAt,
    updatedAt: startedAt,
  });
  try {
    for await (const chunk of source) {
      sent += chunk.byteLength;
      report({
        bytesSent: sent,
        bytesTotal: Math.max(total, sent),
        startedAt,
        updatedAt: new Date().toISOString(),
      });
      yield chunk;
    }
    report({
      bytesSent: sent,
      bytesTotal: Math.max(total, sent),
      startedAt,
      updatedAt: new Date().toISOString(),
      payloadComplete: true,
    });
  } catch (error) {
    report({
      bytesSent: sent,
      bytesTotal: Math.max(total, sent),
      startedAt,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
};

/**
 * Wrap a Node stdout iterable (Buffer chunks) as a counted byte stream.
 * `hostId` attributes live copy bytes to that host's deploy job; without it
 * the stream still counts but publishes nothing.
 */
export const watchCopyNodeStdout = (
  stdout: Readable,
  bytesTotal: number,
  hostId?: string,
): Stream.Stream<Uint8Array, Error> =>
  Stream.fromAsyncIterable(
    countCopyChunks(
      (async function* () {
        for await (const chunk of stdout) {
          yield chunk instanceof Uint8Array
            ? chunk
            : Uint8Array.from(chunk);
        }
      })(),
      bytesTotal,
      hostId,
    ),
    (error) =>
      error instanceof Error ? error : new Error(String(error)),
  );
