import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  nodeRefKey,
  parseNodeRef,
  type NodeRef,
  type NodeRefKey,
} from "@shared/node-ref";

export interface NodeRefIngressTarget {
  readonly ref: NodeRefKey;
  readonly canvasName: string;
  readonly nodeId: string;
}

export type NodeRefIngressResult =
  | {
      readonly ok: true;
      readonly target: NodeRefIngressTarget;
      readonly delivery: "emitted" | "queued";
    }
  | {
      readonly ok: false;
      readonly code: "invalid" | "unresolved" | "superseded";
      readonly message: string;
    };

export interface NodeRefIngressResolver {
  (ref: NodeRef): Promise<{ readonly key: NodeRefKey }>;
}

export interface NodeRefIngress {
  readonly accept: (uri: string) => Promise<NodeRefIngressResult>;
  readonly connect: (sink: (target: NodeRefIngressTarget) => void) => () => void;
  readonly waitForIdle: () => Promise<void>;
  readonly pendingTarget: () => NodeRefIngressTarget | undefined;
  readonly hasAcceptedInput: () => boolean;
}

export interface NodeRefOpenUrlEvent {
  readonly preventDefault: () => void;
}

export const makeNodeRefIngress = (resolve: NodeRefIngressResolver): NodeRefIngress => {
  let revision = 0;
  let pending: NodeRefIngressTarget | undefined;
  let sink: ((target: NodeRefIngressTarget) => void) | undefined;
  let latestTask: Promise<void> = Promise.resolve();

  const deliver = (target: NodeRefIngressTarget): "emitted" | "queued" => {
    if (sink === undefined) {
      pending = target;
      return "queued";
    }
    try {
      sink(target);
      return "emitted";
    } catch {
      pending = target;
      return "queued";
    }
  };

  const accept = (uri: string): Promise<NodeRefIngressResult> => {
    const acceptedRevision = ++revision;
    pending = undefined;
    const task = (async (): Promise<NodeRefIngressResult> => {
      const parsed = parseNodeRef(uri);
      if (!parsed.ok) {
        return { ok: false, code: "invalid", message: parsed.error.message };
      }

      let resolved: { readonly key: NodeRefKey };
      try {
        resolved = await resolve(parsed.value);
      } catch (error) {
        if (acceptedRevision !== revision) {
          return { ok: false, code: "superseded", message: "a newer node reference arrived" };
        }
        return {
          ok: false,
          code: "unresolved",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (acceptedRevision !== revision) {
        return { ok: false, code: "superseded", message: "a newer node reference arrived" };
      }

      const canonical = nodeRefKey(parsed.value);
      if (resolved.key !== canonical) {
        return {
          ok: false,
          code: "unresolved",
          message: "node-reference resolver returned a mismatched canonical key",
        };
      }
      const target: NodeRefIngressTarget = {
        ref: canonical,
        canvasName: parsed.value.canvasName,
        nodeId: parsed.value.nodeId,
      };
      return { ok: true, target, delivery: deliver(target) };
    })();
    latestTask = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const connect = (nextSink: (target: NodeRefIngressTarget) => void): (() => void) => {
    sink = nextSink;
    const queued = pending;
    if (queued !== undefined) {
      pending = undefined;
      try {
        nextSink(queued);
      } catch {
        pending = queued;
      }
    }
    return () => {
      if (sink === nextSink) sink = undefined;
    };
  };

  const waitForIdle = async (): Promise<void> => {
    for (;;) {
      const observed = latestTask;
      await observed;
      if (observed === latestTask) return;
    }
  };

  return {
    accept,
    connect,
    waitForIdle,
    pendingTarget: () => pending,
    hasAcceptedInput: () => revision > 0,
  };
};

export const NODE_REF_RELAY_MAX_BYTES = 8 * 1024;
export const NODE_REF_RELAY_TTL_MS = 5 * 60 * 1_000;
export const NODE_REF_RELAY_FUTURE_TOLERANCE_MS = 5 * 1_000;
export const NODE_REF_RELAY_MAX_RECORDS = 8;
const NODE_REF_RELAY_YIELD_EVERY = 16;
const NODE_REF_RELAY_DIRECTORY_MODE = 0o700;
const NODE_REF_RELAY_FILE_MODE = 0o600;
const NODE_REF_RELAY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface NodeRefRelayRecord {
  readonly version: 1;
  readonly id: string;
  readonly receivedAt: number;
  readonly uri: NodeRefKey;
}

export type NodeRefRelayPublishResult =
  | {
      readonly kind: "published";
      readonly id: string;
      readonly receivedAt: number;
      readonly uri: NodeRefKey;
    }
  | {
      readonly kind: "invalid";
      readonly code: string;
    };

type NodeRefRelayState = "pending" | "processing";
type NodeRefRelayArtifactKind = NodeRefRelayState | "temporary" | "acknowledging";

interface NodeRefRelayArtifact {
  readonly kind: NodeRefRelayArtifactKind;
  readonly id: string;
}

interface ValidatedNodeRefRelayRecord {
  readonly state: NodeRefRelayState;
  readonly path: string;
  readonly mtimeMs: number;
  readonly record: NodeRefRelayRecord;
}

const relayClocks = new Map<string, number>();

const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isMissing = (error: unknown): boolean => isErrorCode(error, "ENOENT");

const requiredUid = (): number => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("node-reference relay requires a POSIX user identity");
  }
  return uid;
};

const permissionMode = (mode: number): number => mode & 0o777;

const validateDirectoryHandle = async (
  path: string,
  uid: number,
  expectedMode: number | undefined,
): Promise<void> => {
  const pathInfo = await lstat(path);
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink() || pathInfo.uid !== uid) {
    throw new Error("node-reference relay path is not a current-user real directory");
  }
  if (expectedMode !== undefined && permissionMode(pathInfo.mode) !== expectedMode) {
    throw new Error("node-reference relay directory permissions are insecure");
  }

  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isDirectory() ||
      info.uid !== uid ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino
    ) {
      throw new Error("node-reference relay directory changed during validation");
    }
    if (expectedMode !== undefined && permissionMode(info.mode) !== expectedMode) {
      throw new Error("node-reference relay directory permissions changed during validation");
    }
  } finally {
    await handle.close();
  }
};

const ensureManagedRelayDirectory = async (
  path: string,
  uid: number,
): Promise<void> => {
  try {
    await mkdir(path, { mode: NODE_REF_RELAY_DIRECTORY_MODE });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  await validateDirectoryHandle(path, uid, NODE_REF_RELAY_DIRECTORY_MODE);
};

const ensureRelayDirectory = async (directory: string): Promise<void> => {
  const uid = requiredUid();
  const runtimeDirectory = dirname(directory);
  const parentDirectory = dirname(runtimeDirectory);
  await validateDirectoryHandle(parentDirectory, uid, undefined);
  await ensureManagedRelayDirectory(runtimeDirectory, uid);
  await ensureManagedRelayDirectory(directory, uid);
};

const relayArtifactPath = (
  directory: string,
  kind: NodeRefRelayArtifactKind,
  id: string,
): string => {
  switch (kind) {
    case "pending":
      return join(directory, `pending-${id}.json`);
    case "processing":
      return join(directory, `processing-${id}.json`);
    case "temporary":
      return join(directory, `.temporary-${id}.json`);
    case "acknowledging":
      return join(directory, `.acknowledging-${id}.json`);
  }
};

const parseRelayArtifactName = (name: string): NodeRefRelayArtifact | undefined => {
  const match = name.match(
    /^(pending|processing)-([0-9a-f-]+)\.json$|^\.(temporary|acknowledging)-([0-9a-f-]+)\.json$/,
  );
  if (match === null) return undefined;
  const kind = (match[1] ?? match[3]) as NodeRefRelayArtifactKind;
  const id = match[2] ?? match[4];
  return id !== undefined && NODE_REF_RELAY_ID.test(id) ? { kind, id } : undefined;
};

const validTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const nextReceivedAt = (directory: string, now: number): number => {
  const previous = relayClocks.get(directory);
  const receivedAt = previous === undefined ? now : Math.max(now, previous);
  relayClocks.delete(directory);
  relayClocks.set(directory, receivedAt);
  while (relayClocks.size > NODE_REF_RELAY_MAX_RECORDS * 2) {
    const oldest = relayClocks.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    relayClocks.delete(oldest);
  }
  return receivedAt;
};

const encodeRelay = (record: NodeRefRelayRecord): Buffer => {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.byteLength > NODE_REF_RELAY_MAX_BYTES) {
    throw new Error("node-reference relay exceeds its storage bound");
  }
  return bytes;
};

const removeExactArtifact = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const readBoundedHandle = async (
  handle: Awaited<ReturnType<typeof open>>,
): Promise<Buffer | undefined> => {
  const output = Buffer.alloc(NODE_REF_RELAY_MAX_BYTES + 1);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read({
      buffer: output,
      offset,
      length: output.byteLength - offset,
      position: offset,
    });
    if (bytesRead === 0) return output.subarray(0, offset);
    offset += bytesRead;
    if (offset > NODE_REF_RELAY_MAX_BYTES) return undefined;
  }
};

const decodeRelay = (
  bytes: Buffer,
  expectedId: string,
  now: number,
  mtimeMs: number,
): NodeRefRelayRecord | undefined => {
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  if (Object.keys(input).sort().join(",") !== "id,receivedAt,uri,version") return undefined;
  if (!("version" in input) || input.version !== 1) return undefined;
  if (!("id" in input) || input.id !== expectedId || !NODE_REF_RELAY_ID.test(expectedId)) {
    return undefined;
  }
  if (!("receivedAt" in input) || typeof input.receivedAt !== "number") return undefined;
  if (!("uri" in input) || typeof input.uri !== "string") return undefined;
  if (!validTimestamp(input.receivedAt)) return undefined;
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined;
  if (input.receivedAt - now > NODE_REF_RELAY_FUTURE_TOLERANCE_MS) return undefined;
  if (mtimeMs - now > NODE_REF_RELAY_FUTURE_TOLERANCE_MS) return undefined;
  if (now - input.receivedAt > NODE_REF_RELAY_TTL_MS) return undefined;
  if (now - mtimeMs > NODE_REF_RELAY_TTL_MS) return undefined;
  const parsed = parseNodeRef(input.uri);
  if (!parsed.ok || nodeRefKey(parsed.value) !== input.uri) return undefined;
  return {
    version: 1,
    id: expectedId,
    receivedAt: input.receivedAt,
    uri: input.uri,
  };
};

const relayIdentityMatches = (bytes: Buffer, expectedId: string): boolean => {
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  if (Object.keys(input).sort().join(",") !== "id,receivedAt,uri,version") return false;
  if (!("version" in input) || input.version !== 1) return false;
  if (!("id" in input) || input.id !== expectedId) return false;
  if (!("receivedAt" in input) || typeof input.receivedAt !== "number") return false;
  if (!("uri" in input) || typeof input.uri !== "string") return false;
  if (!validTimestamp(input.receivedAt)) return false;
  const parsed = parseNodeRef(input.uri);
  return parsed.ok && nodeRefKey(parsed.value) === input.uri;
};

const readManagedRelayRecord = async (
  path: string,
  expectedId: string,
  state: NodeRefRelayState,
  now: number,
): Promise<ValidatedNodeRefRelayRecord | undefined> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error) || isErrorCode(error, "ELOOP")) return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    const uid = requiredUid();
    if (
      !before.isFile() ||
      before.uid !== uid ||
      permissionMode(before.mode) !== NODE_REF_RELAY_FILE_MODE ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > NODE_REF_RELAY_MAX_BYTES
    ) {
      return undefined;
    }
    const bytes = await readBoundedHandle(handle);
    if (bytes === undefined) return undefined;
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.uid !== uid ||
      permissionMode(after.mode) !== NODE_REF_RELAY_FILE_MODE ||
      after.nlink !== 1 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return undefined;
    }
    const record = decodeRelay(bytes, expectedId, now, after.mtimeMs);
    return record === undefined
      ? undefined
      : { state, path, mtimeMs: after.mtimeMs, record };
  } finally {
    await handle.close();
  }
};

const cleanupTransientArtifact = async (
  path: string,
  now: number,
): Promise<void> => {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const uid = requiredUid();
  const secure =
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.uid === uid &&
    permissionMode(info.mode) === NODE_REF_RELAY_FILE_MODE &&
    info.nlink === 1;
  const stale = now - info.mtimeMs > NODE_REF_RELAY_TTL_MS;
  const tooFarFuture = info.mtimeMs - now > NODE_REF_RELAY_FUTURE_TOLERANCE_MS;
  if (!secure || stale || tooFarFuture) await removeExactArtifact(path);
};

const compareNewest = (
  left: ValidatedNodeRefRelayRecord,
  right: ValidatedNodeRefRelayRecord,
): number =>
  right.record.receivedAt - left.record.receivedAt ||
  right.mtimeMs - left.mtimeMs ||
  right.record.id.localeCompare(left.record.id) ||
  Number(right.state === "processing") - Number(left.state === "processing");

const scanRelayRecords = async (
  directory: string,
  now: number,
): Promise<ReadonlyArray<ValidatedNodeRefRelayRecord>> => {
  const retained: ValidatedNodeRefRelayRecord[] = [];
  let managedCount = 0;
  const stream = await opendir(directory);
  try {
    for await (const entry of stream) {
      const artifact = parseRelayArtifactName(entry.name);
      if (artifact === undefined) continue;
      managedCount += 1;
      const path = relayArtifactPath(directory, artifact.kind, artifact.id);
      if (artifact.kind === "temporary" || artifact.kind === "acknowledging") {
        await cleanupTransientArtifact(path, now);
      } else {
        const candidate = await readManagedRelayRecord(path, artifact.id, artifact.kind, now);
        if (candidate === undefined) {
          await removeExactArtifact(path);
        } else {
          const duplicate = retained.findIndex(
            (existing) => existing.record.id === candidate.record.id,
          );
          if (duplicate >= 0) {
            const existing = retained[duplicate];
            if (existing !== undefined && compareNewest(existing, candidate) <= 0) {
              await removeExactArtifact(candidate.path);
            } else if (existing !== undefined) {
              await removeExactArtifact(existing.path);
              retained.splice(duplicate, 1, candidate);
            }
          } else {
            retained.push(candidate);
          }
          retained.sort(compareNewest);
          while (retained.length > NODE_REF_RELAY_MAX_RECORDS) {
            const stale = retained.pop();
            if (stale !== undefined) await removeExactArtifact(stale.path);
          }
        }
      }
      if (managedCount % NODE_REF_RELAY_YIELD_EVERY === 0) await yieldToEventLoop();
    }
  } finally {
    await stream.close().catch(() => undefined);
  }
  return retained;
};

export const publishNodeRefRelay = async (
  directory: string,
  rawUri: string,
  now = Date.now(),
): Promise<NodeRefRelayPublishResult> => {
  if (!validTimestamp(now)) return { kind: "invalid", code: "timestamp" };
  const parsed = parseNodeRef(rawUri);
  if (!parsed.ok || nodeRefKey(parsed.value) !== rawUri) {
    return { kind: "invalid", code: parsed.ok ? "canonical" : parsed.error.code };
  }
  const id = randomUUID();
  const receivedAt = nextReceivedAt(directory, now);
  const record: NodeRefRelayRecord = { version: 1, id, receivedAt, uri: rawUri };
  const bytes = encodeRelay(record);
  await ensureRelayDirectory(directory);
  const temporary = relayArtifactPath(directory, "temporary", id);
  const pending = relayArtifactPath(directory, "pending", id);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      NODE_REF_RELAY_FILE_MODE,
    );
    await handle.writeFile(bytes);
    await handle.chmod(NODE_REF_RELAY_FILE_MODE);
    await handle.utimes(receivedAt / 1_000, receivedAt / 1_000);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, pending);
  } finally {
    await handle?.close().catch(() => undefined);
    await removeExactArtifact(temporary);
  }
  await scanRelayRecords(directory, now);
  return { kind: "published", id, receivedAt, uri: rawUri };
};

export const publishNodeRefOpenUrl = (
  event: NodeRefOpenUrlEvent,
  uri: string,
  directory: string,
  now = Date.now(),
): Promise<NodeRefRelayPublishResult> => {
  event.preventDefault();
  return publishNodeRefRelay(directory, uri, now);
};

export const claimLatestNodeRefRelay = async (
  directory: string,
  now = Date.now(),
): Promise<NodeRefRelayRecord | undefined> => {
  if (!validTimestamp(now)) throw new Error("node-reference relay timestamp is invalid");
  await ensureRelayDirectory(directory);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidates = await scanRelayRecords(directory, now);
    const newest = candidates[0];
    if (newest === undefined) return undefined;
    for (const superseded of candidates.slice(1)) {
      await removeExactArtifact(superseded.path);
    }
    if (newest.state === "processing") return newest.record;

    const processing = relayArtifactPath(directory, "processing", newest.record.id);
    try {
      await lstat(processing);
      await removeExactArtifact(newest.path);
      continue;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await rename(newest.path, processing);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const claimed = await readManagedRelayRecord(
      processing,
      newest.record.id,
      "processing",
      now,
    );
    if (claimed !== undefined) return claimed.record;
    await removeExactArtifact(processing);
  }
  return undefined;
};

export const acknowledgeNodeRefRelay = async (
  directory: string,
  id: string,
): Promise<boolean> => {
  if (!NODE_REF_RELAY_ID.test(id)) return false;
  await ensureRelayDirectory(directory);
  const processing = relayArtifactPath(directory, "processing", id);
  const acknowledging = relayArtifactPath(directory, "acknowledging", id);
  try {
    await rename(processing, acknowledging);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  let valid = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(acknowledging, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      info.isFile() &&
      info.uid === requiredUid() &&
      permissionMode(info.mode) === NODE_REF_RELAY_FILE_MODE &&
      info.nlink === 1 &&
      info.size >= 1 &&
      info.size <= NODE_REF_RELAY_MAX_BYTES
    ) {
      const bytes = await readBoundedHandle(handle);
      if (bytes !== undefined) {
        const after = await handle.stat();
        valid =
          after.isFile() &&
          after.uid === info.uid &&
          permissionMode(after.mode) === NODE_REF_RELAY_FILE_MODE &&
          after.nlink === 1 &&
          after.size === info.size &&
          after.mtimeMs === info.mtimeMs &&
          relayIdentityMatches(bytes, id);
      }
    }
  } catch (error) {
    if (!isErrorCode(error, "ELOOP")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await removeExactArtifact(acknowledging);
  }
  return valid;
};
