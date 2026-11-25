/**
 * The window machine's end of `file-bytes` (0.12.1, X3): a file read from
 * another machine in chunks within the link's window of two, a text too large
 * for one frame read whole that way, and a drop staged there chunk by chunk
 * and hashed as it goes.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import type { FilePath, FilesNodeRef } from "../src/shared/files";
import { FilesRefused, type FilesLinkFailure } from "../src/shared/files-link";
import { decodeChunk, encodeChunk, FILE_BYTES_CHUNK_MAX } from "../src/shared/files-bytes-link";
import { FilesLink } from "../src/core/files/link";
import { FileBytesLink } from "../src/core/files/bytes-link";
import { makeFilesRemote } from "../src/core/files/link-client";
import { bindLinkChannel } from "../src/core/link/contract";
import type { LinkSession } from "../src/core/link/types";
import { MachineRepository } from "../src/core/machines/repository";
import { hello, machineLinkLayer, makeSessions, pair } from "./support/link-pair";

const MINI = "mini";
const ref: FilesNodeRef = { canvas: "factory", node: asNodeId("files-1") };
const stamp = { mtimeMs: 1, size: 1 };
const path = (raw: string) => raw as FilePath;
const STREAM = "a".repeat(32);
const UPLOAD = "b".repeat(32);

const links = makeSessions();
const dirs: string[] = [];
afterEach(async () => {
  await links.closeAll();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** The client over a link to a host whose file is `body`, which records every byte request. */
const fixture = async (body: Buffer, options: { readonly readKind?: "too-large" | "text" } = {}) => {
  let windowSession: LinkSession | undefined;
  const machines = { peer: (name: string) => Effect.succeed(name === MINI ? { machineName: MINI, installationId: "mini-install" } : undefined) } as never;
  const remote = await Effect.runPromise(makeFilesRemote().pipe(
    Effect.provide(Layer.mergeAll(machineLinkLayer(() => windowSession), Layer.succeed(MachineRepository, machines))),
  ));
  const seen: string[] = [];
  const staged: Buffer[] = [];
  let ended: string | undefined;
  const die = () => Effect.die("unused");
  const files = bindLinkChannel(FilesLink, {
    requests: {
      Open: die, Close: die, Count: die, List: die, Write: die, Create: die, Rename: die, Move: die, Trash: die, Import: die, Search: die,
      Read: () => Effect.succeed(options.readKind === "text" ? { kind: "text", text: "small", stamp } : { kind: "too-large", size: body.length, stamp }),
    },
    event: () => Effect.void,
  });
  const bytes = bindLinkChannel(FileBytesLink, {
    requests: {
      ReadOpen: () => Effect.sync(() => { seen.push("ReadOpen"); return { stream: STREAM, size: body.length, stamp }; }),
      // A little later each, so requests overlap on the link.
      ReadChunk: ({ offset, length }) => Effect.sync(() => { seen.push(`ReadChunk ${String(offset)} ${String(length)}`); return { data: encodeChunk(body.subarray(offset, offset + length)) }; }).pipe(Effect.delay("5 millis")),
      ReadClose: () => Effect.sync(() => { seen.push("ReadClose"); return null; }),
      ImportOpen: ({ name, size }) => Effect.sync(() => { seen.push(`ImportOpen ${name} ${String(size)}`); return { upload: UPLOAD }; }),
      ImportChunk: ({ offset, data }) => Effect.sync(() => { seen.push(`ImportChunk ${String(offset)}`); staged.push(Buffer.from(decodeChunk(data)!)); return null; }),
      ImportEnd: ({ sha256 }): Effect.Effect<ReadonlyArray<{ path: FilePath; dir: boolean }>, FilesLinkFailure> => {
        ended = sha256;
        return createHash("sha256").update(Buffer.concat(staged)).digest("hex") === sha256
          ? Effect.succeed([{ path: path("drop.bin"), dir: false }])
          : Effect.fail(new FilesRefused({ error: "failed" }));
      },
    },
  });
  const quiet = bindLinkChannel(FileBytesLink, { requests: { ReadOpen: die, ReadChunk: die, ReadClose: die, ImportOpen: die, ImportChunk: die, ImportEnd: die } });
  const quietFiles = bindLinkChannel(FilesLink, {
    requests: { Open: die, Close: die, Count: die, List: die, Read: die, Write: die, Create: die, Rename: die, Move: die, Trash: die, Import: die, Search: die },
    event: () => Effect.void,
  });
  const { a, b } = pair(
    { self: hello("macbook"), channels: { files: quietFiles, "file-bytes": quiet } },
    { self: hello(MINI), channels: { files, "file-bytes": bytes } },
  );
  links.keep(a, b);
  await Promise.all([a.ready, b.ready]);
  windowSession = a;
  return { remote, seen, staged, ended: () => ended };
};

describe("files remote: bytes", () => {
  it("keeps every read within the window, so five at once are all answered", async () => {
    const body = Buffer.alloc(FILE_BYTES_CHUNK_MAX * 5, 1);
    const f = await fixture(body);
    const reader = await f.remote.bytes(MINI, ref, path("big.bin"));
    if (!reader.ok) throw new Error(reader.error);
    const parts = await Promise.all([0, 1, 2, 3, 4].map((at) => reader.value.read(at * FILE_BYTES_CHUNK_MAX, 64 * 1024)));
    // Each asked for no more than one chunk: the 64 KiB the protocol pulls is cut to 48.
    expect(parts.map((part) => part.byteLength)).toEqual(Array(5).fill(FILE_BYTES_CHUNK_MAX));
    await reader.value.close();
    expect(f.seen.at(-1)).toBe("ReadClose");
  });

  it("reads a text too large for one frame whole, in chunks", async () => {
    const text = "é".repeat(FILE_BYTES_CHUNK_MAX);
    const body = Buffer.from(text);
    const f = await fixture(body);
    expect(await f.remote.read(MINI, ref, path("big.md"))).toEqual({ ok: true, value: { kind: "text", text, stamp } });
    expect(f.seen.filter((line) => line.startsWith("ReadChunk"))).toHaveLength(Math.ceil(body.length / FILE_BYTES_CHUNK_MAX));
  });

  it("reads such a file with a NUL as binary, as the host would", async () => {
    const body = Buffer.concat([Buffer.alloc(FILE_BYTES_CHUNK_MAX * 2, 65), Buffer.from([0])]);
    const f = await fixture(body);
    expect(await f.remote.read(MINI, ref, path("big.txt"))).toMatchObject({ ok: true, value: { kind: "binary" } });
  });

  it("leaves a text that fits one frame to the files channel", async () => {
    const f = await fixture(Buffer.from("small"), { readKind: "text" });
    expect(await f.remote.read(MINI, ref, path("a.md"))).toEqual({ ok: true, value: { kind: "text", text: "small", stamp } });
    expect(f.seen).toEqual([]);
  });

  it("stages a drop in order, hashed, and imports it there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junto-bytes-client-"));
    dirs.push(dir);
    const body = Buffer.alloc(FILE_BYTES_CHUNK_MAX * 2 + 7, 5);
    await writeFile(join(dir, "drop.bin"), body);
    const f = await fixture(Buffer.alloc(0));
    expect(await f.remote.import(MINI, ref, path(""), [join(dir, "drop.bin")])).toEqual({ ok: true, value: [{ path: "drop.bin", dir: false }] });
    expect(f.seen).toEqual([`ImportOpen drop.bin ${String(body.length)}`, "ImportChunk 0", `ImportChunk ${String(FILE_BYTES_CHUNK_MAX)}`, `ImportChunk ${String(FILE_BYTES_CHUNK_MAX * 2)}`]);
    expect(Buffer.compare(Buffer.concat(f.staged), body)).toBe(0);
  });

  it("refuses a dropped folder is-dir, and asks nothing of the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junto-bytes-client-"));
    dirs.push(dir);
    await mkdir(join(dir, "folder"));
    const f = await fixture(Buffer.alloc(0));
    expect(await f.remote.import(MINI, ref, path(""), [join(dir, "folder")])).toEqual({ ok: false, error: "is-dir" });
    expect(f.seen).toEqual([]);
  });
});
