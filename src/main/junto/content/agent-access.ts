import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  renameSync,
  type Stats,
} from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ContentRef } from "@shared/content";
import { isContentPart } from "@shared/content";
import type { CanvasNode, Task } from "@shared/canvas";
import { contentObjectPath } from "./paths";
import { ContentStoreError } from "./store";

const COPY_CHUNK_BYTES = 64 * 1024;
const MATERIALIZED_DIRECTORY = "materialized";
const MATERIALIZED_MODE = 0o700;
const MATERIALIZED_FILE_MODE = 0o600;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

const lstatOrUndefined = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** Stable identity comparison; media metadata is descriptive, not identity. */
export const sameContentIdentity = (
  left: Pick<ContentRef, "sha256" | "byteLength">,
  right: Pick<ContentRef, "sha256" | "byteLength">,
): boolean =>
  left.sha256 === right.sha256 && left.byteLength === right.byteLength;

/** Find the canonical ref carried by a task history part. */
export const taskContentRef = (
  task: Task,
  requested: Pick<ContentRef, "sha256" | "byteLength">,
): ContentRef | undefined => {
  for (const message of task.history) {
    for (const part of message.parts) {
      if (!isContentPart(part)) continue;
      if (sameContentIdentity(part.ref, requested)) return part.ref;
    }
  }
  return undefined;
};

/** Return every distinct ContentRef carried by a task, preserving task order. */
export const taskContentRefs = (task: Task): ReadonlyArray<ContentRef> => {
  const seen = new Set<string>();
  const refs: ContentRef[] = [];
  for (const message of task.history) {
    for (const part of message.parts) {
      if (!isContentPart(part)) continue;
      const key = `${part.ref.sha256}/${part.ref.byteLength}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(part.ref);
    }
  }
  return refs;
};

/** Extract task items from either a task or requests sink. */
export const taskItemsForNode = (node: CanvasNode): ReadonlyArray<Task> => {
  const kind = node.ether?.entity?.kind;
  if (kind === "task") return node.ether?.tasks?.items ?? [];
  if (kind === "requests") return node.ether?.requests?.items ?? [];
  return [];
};

/** Encode user-controlled scope identifiers into path-safe, non-ambiguous names. */
const scopeSegment = (value: string): string =>
  (() => {
    const encoded = Buffer.from(value, "utf8").toString("hex");
    if (encoded.length <= 160) return encoded || "empty";
    // Keep the directory component bounded without allowing two long ids
    // sharing a prefix to collapse onto the same task workspace.
    return `${encoded.slice(0, 96)}-${createHash("sha256")
      .update(value, "utf8")
      .digest("hex")}`;
  })();

const assertInside = (root: string, candidate: string): void => {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(rootResolved, rel) !== candidateResolved
  ) {
    throw new ContentStoreError(
      "invalid",
      "content materialization path escapes the Junto work directory",
    );
  }
};

const safeFileName = (
  value: string | undefined,
  sha256: string,
  strict: boolean,
): string => {
  const fallback = `content-${sha256.slice(0, 16)}`;
  if (value === undefined || value.trim().length === 0) return fallback;
  const trimmed = value.trim();
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(":") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith(" ") ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    if (!strict) return fallback;
    throw new ContentStoreError(
      "invalid",
      "content materialization name must be a single path-safe filename",
    );
  }
  // The digest prefix and separator are part of the filename, leaving 190
  // bytes under the common 255-byte filesystem component limit.
  if (Buffer.byteLength(trimmed, "utf8") > 190) {
    if (!strict) return fallback;
    throw new ContentStoreError(
      "invalid",
      "content materialization name is too long for a digest-qualified path",
    );
  }
  return trimmed;
};

export const contentMaterializationRoot = (workHome: string): string =>
  join(workHome, MATERIALIZED_DIRECTORY);

export const contentMaterializationPath = (input: {
  readonly workHome: string;
  readonly canvasName: string;
  readonly targetNodeId: string;
  readonly taskId: string;
  readonly ref: ContentRef;
  readonly name?: string;
}): string => {
  const root = contentMaterializationRoot(input.workHome);
  const directory = join(
    root,
    scopeSegment(input.canvasName),
    scopeSegment(input.targetNodeId),
    scopeSegment(input.taskId),
  );
  const fileName = `${input.ref.sha256}-${safeFileName(
    input.name ?? input.ref.displayName,
    input.ref.sha256,
    input.name !== undefined,
  )}`;
  const path = join(directory, fileName);
  assertInside(root, path);
  return path;
};

const assertNoSymlinkPath = async (root: string, directory: string): Promise<void> => {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ContentStoreError(
      "symlink",
      "materialization root is not a private directory",
    );
  }
  const rootReal = await realpath(root);
  const directoryReal = await realpath(directory);
  assertInside(rootReal, directoryReal);
  const rel = relative(rootReal, directoryReal);
  let current = rootReal;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ContentStoreError("symlink", "materialization directory is not a directory");
    }
  }
};

const ensureDirectory = async (root: string, directory: string): Promise<void> => {
  const parent = dirname(root);
  const parentInfo = lstatOrUndefined(parent);
  if (parentInfo === undefined) {
    // The control server normally creates workHome before admitting a caller,
    // but keep this helper safe and self-contained for recovery/tests.
    mkdirSync(parent, { recursive: true, mode: MATERIALIZED_MODE });
  } else if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new ContentStoreError("symlink", "work directory parent is not a directory");
  }
  const rootInfo = lstatOrUndefined(root);
  if (rootInfo === undefined) {
    mkdirSync(root, { recursive: false, mode: MATERIALIZED_MODE });
  } else if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ContentStoreError("symlink", "materialization root is not a private directory");
  }
  const rel = relative(resolve(root), resolve(directory));
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = lstatOrUndefined(current);
    if (info === undefined) {
      mkdirSync(current, { recursive: false, mode: MATERIALIZED_MODE });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ContentStoreError("symlink", "materialization directory is not a directory");
    }
  }
  await assertNoSymlinkPath(root, directory);
};

const hashExisting = async (path: string): Promise<{ readonly sha256: string; readonly byteLength: number }> => {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    let byteLength = 0;
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: COPY_CHUNK_BYTES,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
    }
    return { sha256: hash.digest("hex"), byteLength };
  } finally {
    await handle.close();
  }
};

/**
 * Copy a verified canonical object into the agent's task-scoped workspace.
 * The copy is streamed and hashed; no Base64 or whole-file buffer is created.
 */
export const materializeContentObject = async (input: {
  readonly contentRoot: string;
  readonly workHome: string;
  readonly canvasName: string;
  readonly targetNodeId: string;
  readonly taskId: string;
  readonly ref: ContentRef;
  readonly name?: string;
}): Promise<{ readonly path: string; readonly created: boolean }> => {
  const source = contentObjectPath(input.contentRoot, input.ref.sha256);
  const destination = contentMaterializationPath(input);
  const root = contentMaterializationRoot(input.workHome);
  assertInside(root, destination);

  const sourceInfo = lstatOrUndefined(source);
  if (sourceInfo === undefined) {
    throw new ContentStoreError("missing", "content object file is absent");
  }
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new ContentStoreError("symlink", "content object is not a regular file");
  }
  if (sourceInfo.size !== input.ref.byteLength) {
    throw new ContentStoreError("corrupt", "content object size does not match ContentRef");
  }

  const directory = dirname(destination);
  await ensureDirectory(root, directory);
  const existing = lstatOrUndefined(destination);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ContentStoreError("symlink", "materialized path is not a regular file");
    }
    const observed = await hashExisting(destination);
    if (
      observed.sha256 !== input.ref.sha256 ||
      observed.byteLength !== input.ref.byteLength
    ) {
      throw new ContentStoreError("corrupt", "existing materialized file does not match ContentRef");
    }
    return { path: destination, created: false };
  }

  const temp = join(
    directory,
    `.${input.ref.sha256}.partial-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
  );
  assertInside(root, temp);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    destinationHandle = await open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      MATERIALIZED_FILE_MODE,
    );
    const hash = createHash("sha256");
    let byteLength = 0;
    const stream = sourceHandle.createReadStream({
      autoClose: false,
      highWaterMark: COPY_CHUNK_BYTES,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const result = await destinationHandle.write(bytes, offset, bytes.length - offset);
        offset += result.bytesWritten;
      }
    }
    if (hash.digest("hex") !== input.ref.sha256 || byteLength !== input.ref.byteLength) {
      throw new ContentStoreError("corrupt", "materialized copy does not match ContentRef");
    }
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    renameSync(temp, destination);
    return { path: destination, created: true };
  } catch (error) {
    if (destinationHandle !== undefined) {
      try {
        await destinationHandle.close();
      } catch {
        // best effort cleanup
      }
    }
    if (sourceHandle !== undefined) {
      try {
        await sourceHandle.close();
      } catch {
        // best effort cleanup
      }
    }
    try {
      await rm(temp, { force: true });
    } catch {
      // best effort cleanup
    }
    if (error instanceof ContentStoreError) throw error;
    throw new ContentStoreError(
      "io",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
};
