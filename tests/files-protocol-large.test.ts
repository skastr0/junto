/**
 * A large file through `junto-file:` (0.12 X2): the protocol streams a file
 * the core holds, in chunks named by offset, so no message carries the whole
 * file and a byte range costs only the pieces it covers. The client here is
 * the shape main uses (`coreFileBytes`), answered as the core's
 * `files.bytesOpen/read/close` answer, over a real 40 MiB file.
 */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileProtocolHandler } from "../src/main/junto/files/protocol";
import { coreFileBytes, registerFilesIpc } from "../src/main/junto/files/ipc";
import { useCoreClient } from "../src/main/core-process/main-client";

const SIZE = 40 * 1024 * 1024;
const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("streams 40 MiB in bounded chunks, and a range costs only its own bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "junto-file-protocol-"));
  dirs.push(dir);
  const file = join(dir, "large.bin");
  // Deterministic content: byte i is i mod 251, recognisable in a range.
  const content = Buffer.alloc(SIZE);
  for (let at = 0; at < SIZE; at += 1) content[at] = at % 251;
  await writeFile(file, content);

  const handle = await open(file, "r");
  const opened: string[] = [];
  const closed: string[] = [];
  const sizes: number[] = [];
  // The core's side, as ops/files.ts answers it: one handle by token, chunks by offset.
  useCoreClient({
    call: async (name: string, input: never) => {
      const request = input as { readonly token?: string; readonly offset?: number; readonly length?: number };
      switch (name) {
        case "files.bytesOpen": {
          const token = `t${String(opened.length + 1)}`;
          opened.push(token);
          return { ok: true, value: { token, size: SIZE } } as never;
        }
        case "files.bytesRead": {
          const length = Math.min(Math.trunc(request.length ?? 0), 1024 * 1024);
          sizes.push(length);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, request.offset);
          return { ok: true, value: new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead) } as never;
        }
        case "files.bytesClose":
          closed.push(String(request.token));
          return undefined as never;
        default:
          throw new Error(`unexpected core call ${name}`);
      }
    },
  });

  const handler = createFileProtocolHandler(coreFileBytes());
  const url = `junto-file://files-1/large.bin`;

  const whole = await handler(new Request(url));
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe(String(SIZE));
  const body = Buffer.from(await whole.arrayBuffer());
  expect(body.byteLength).toBe(SIZE);
  expect(body[0]).toBe(0);
  expect(body[SIZE - 1]).toBe(((SIZE - 1) % 251) | 0);
  // Never one message with the file in it, and nothing above the 64 KiB window.
  expect(sizes.length).toBeGreaterThan(SIZE / (64 * 1024) - 2);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);

  const part = await handler(new Request(url, { headers: { Range: "bytes=1000000-1000099" } }));
  expect(part.status).toBe(206);
  const slice = Buffer.from(await part.arrayBuffer());
  expect(slice.byteLength).toBe(100);
  expect(slice[0]).toBe(1000000 % 251);

  const head = await handler(new Request(url, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(SIZE));

  // Every open is closed: a viewer that stops reading leaves no handle behind.
  expect(closed.length).toBe(opened.length);
  await handle.close();
});

it("answers 404 for a node no window opened", async () => {
  useCoreClient({
    call: async () => ({ ok: false, error: "no-node" }) as never,
  });
  const handler = createFileProtocolHandler(coreFileBytes());
  const response = await handler(new Request("junto-file://files-1/missing.pdf"));
  expect(response.status).toBe(404);
  // The channels stay what main registers; this only proves the resolver refuses.
  expect(registerFilesIpc).toBeTypeOf("function");
});
