import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ContentRef } from "../src/shared/content";
import { ContentPathArgs } from "../src/shared/work-control";
import { Task } from "../src/shared/work-model";
import {
  contentMaterializationPath,
  materializeContentObject,
  taskContentRef,
} from "../src/main/vellum-command/content/agent-access";
import { ingestContentBytes } from "../src/main/vellum-command/content/store";

const ref = Schema.decodeUnknownSync(ContentRef)({
  sha256: "".padStart(64, "a"),
  byteLength: 11,
  mediaType: "text/plain",
  displayName: "hello.txt",
});

const task = Schema.decodeUnknownSync(Task)({
  id: "task-1",
  state: "submitted",
  history: [
    {
      messageId: "message-1",
      role: "user",
      parts: [{ kind: "text", text: "read this" }, { kind: "content", ref }],
    },
  ],
});

describe("process-bound content access helpers", () => {
  it("rejects host paths embedded in a ContentRef access request", () => {
    const decoded = Schema.decodeUnknownResult(ContentPathArgs)({
      target: "tasks",
      task: task.id,
      ref: {
        ...ref,
        path: "/tmp/operator-owned-file",
      },
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("authorizes only identities carried by the task", () => {
    expect(taskContentRef(task, ref)).toEqual(ref);
    const otherRef = Schema.decodeUnknownSync(ContentRef)({
      ...ref,
      sha256: "".padStart(64, "b"),
    });
    expect(
      taskContentRef(task, otherRef),
    ).toBeUndefined();
  });

  it("streams an immutable object into a stable task workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-command-content-access-"));
    const contentRoot = join(root, "content");
    const workHome = join(root, "work");
    const bytes = Buffer.from("hello world");
    await mkdir(workHome, { recursive: true });
    const actualRef = Schema.decodeUnknownSync(ContentRef)({
      ...ref,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    await ingestContentBytes({
      root: contentRoot,
      source: bytes,
      mediaType: actualRef.mediaType,
      displayName: actualRef.displayName,
    });

    const first = await materializeContentObject({
      contentRoot,
      workHome,
      canvasName: "factory",
      targetNodeId: "tasks",
      taskId: task.id,
      ref: actualRef,
    });
    expect(first.created).toBe(true);
    expect(first.path).toBe(
      contentMaterializationPath({
        workHome,
        canvasName: "factory",
        targetNodeId: "tasks",
        taskId: task.id,
        ref: actualRef,
      }),
    );
    expect(await readFile(first.path, "utf8")).toBe("hello world");

    const second = await materializeContentObject({
      contentRoot,
      workHome,
      canvasName: "factory",
      targetNodeId: "tasks",
      taskId: task.id,
      ref: actualRef,
    });
    expect(second).toEqual({ path: first.path, created: false });
  });

  it("rejects traversal names and symlinked materialization roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-command-content-access-safe-"));
    const contentRoot = join(root, "content");
    const workHome = join(root, "work");
    const bytes = Buffer.from("hello world");
    const actualRef = Schema.decodeUnknownSync(ContentRef)({
      ...ref,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    await ingestContentBytes({
      root: contentRoot,
      source: bytes,
      mediaType: actualRef.mediaType,
    });

    await expect(
      materializeContentObject({
        contentRoot,
        workHome,
        canvasName: "factory",
        targetNodeId: "tasks",
        taskId: task.id,
        ref: actualRef,
        name: "../escape.bin",
      }),
    ).rejects.toThrow(/path-safe filename/);

    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(workHome, { recursive: true });
    await symlink(outside, join(workHome, "materialized"));
    await expect(
      materializeContentObject({
        contentRoot,
        workHome,
        canvasName: "factory",
        targetNodeId: "tasks",
        taskId: task.id,
        ref: actualRef,
      }),
    ).rejects.toThrow(/materialization root/);
  });
});
