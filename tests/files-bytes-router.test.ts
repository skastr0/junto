/**
 * Another machine's bytes in the window (0.12.1, X3): the router reads a
 * file under a node a window has open on another machine over the link, and
 * `junto-file:` serves it with the very headers a local file gets (remote-
 * security term 7: type, nosniff, CSP and origin, no new MIME path). A drop
 * onto such a node is copied there.
 */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileImported, FilePath, FilesNodeRef, FilesResult } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import { makeFilesRouter, type FilesRemotePort } from "../src/core/files/router";
import type { FileBytesReader } from "../src/core/files/bytes";
import type { FilesService } from "../src/core/files/service";
import { createFileProtocolHandler } from "../src/app/files/protocol";

const HERE = "studio";
const here: FilesNodeRef = { canvas: "c", node: asNodeId("files-here") };
const away: FilesNodeRef = { canvas: "c", node: asNodeId("files-away") };
const hosts: Record<string, string> = { [here.node]: HERE, [away.node]: "mini" };
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
const HTML = `<!doctype html><script>alert(1)</script>`;

const dirs: string[] = [];
afterEach(async () => { while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }); });

const readerOf = (body: Buffer): FileBytesReader => ({
  size: body.length,
  read: async (offset, length) => new Uint8Array(body.subarray(offset, offset + Math.min(length, 48 * 1024))),
  close: async () => undefined,
});

const stage = async () => {
  const dir = await mkdtemp(join(tmpdir(), "junto-bytes-router-"));
  dirs.push(dir);
  const calls: string[] = [];
  const local = {
    open: async () => ({ ok: true, value: { name: "here", repo: false } }),
    closeSubscriber: () => undefined,
    bytes: async (node: string, path: FilePath) => {
      calls.push(`local bytes ${node} ${path}`);
      if (node !== here.node) return { ok: false, error: "no-node" };
      const file = join(dir, path);
      await writeFile(file, path.endsWith(".svg") ? SVG : HTML);
      const handle = await open(file, "r");
      return { ok: true, value: { handle, size: (await handle.stat()).size } };
    },
    import: async () => (calls.push("local import"), { ok: true, value: [] }),
  } as unknown as FilesService;
  const remote = {
    open: async () => ({ ok: true, value: { name: "away", repo: false } }),
    close: async () => ({ ok: true, value: null }),
    onChange: () => () => undefined,
    bytes: async (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileBytesReader>> => {
      calls.push(`remote bytes ${machine} ${ref.canvas} ${ref.node} ${path}`);
      return { ok: true, value: readerOf(Buffer.from(path.endsWith(".svg") ? SVG : HTML)) };
    },
    import: async (machine: string, _ref: FilesNodeRef, into: FilePath, sources: ReadonlyArray<string>): Promise<FilesResult<ReadonlyArray<FileImported>>> => {
      calls.push(`remote import ${machine} ${into} ${sources.join(",")}`);
      return { ok: true, value: [{ path: "drop.txt" as FilePath, dir: false }] };
    },
  } as unknown as FilesRemotePort;
  const router = makeFilesRouter({
    local,
    remote: () => remote,
    node: async (ref) => ({ host: hosts[ref.node] ?? HERE, root: "/root" }),
    machineName: async () => HERE,
    send: () => undefined,
    enabled: true,
  });
  return { router, calls };
};

const fetchOf = (handler: (request: Request) => Promise<Response>, node: string, path: string) =>
  handler(new Request(`junto-file://${node}/${path}`));

describe("bytes from another machine's node", () => {
  it("reads over the link only for a node a window here has open on that machine", async () => {
    const { router, calls } = await stage();
    // Not opened here: the local service, which has no such node.
    expect(await router.bytes(away.node, "a.svg" as FilePath)).toEqual({ ok: false, error: "no-node" });
    await router.open(1, away);
    const read = await router.bytes(away.node, "a.svg" as FilePath);
    expect(read.ok).toBe(true);
    expect(calls).toEqual([`local bytes ${away.node} a.svg`, `remote bytes mini c ${away.node} a.svg`]);
  });

  it("serves a remote SVG and HTML with exactly the headers the same local file gets", async () => {
    const { router } = await stage();
    await router.open(1, away);
    const handler = createFileProtocolHandler((node, path) => router.bytes(node, path));
    for (const name of ["a.svg", "a.html"]) {
      const local = await fetchOf(handler, here.node, name);
      const remote = await fetchOf(handler, away.node, name);
      expect(remote.status).toBe(200);
      expect([...remote.headers.entries()]).toEqual([...local.headers.entries()]);
      expect(remote.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(remote.headers.get("Content-Security-Policy")).toContain("sandbox");
      expect(await remote.text()).toBe(await local.text());
    }
    // HTML never goes out as HTML, from either machine.
    expect((await fetchOf(handler, away.node, "a.html")).headers.get("Content-Type")).not.toMatch(/html/u);
  });

  it("sends a drop on another machine's node to that machine, and a local one to the local service", async () => {
    const { router, calls } = await stage();
    expect(await router.import(away, "" as FilePath, ["/Users/me/drop.txt"])).toEqual({ ok: true, value: [{ path: "drop.txt", dir: false }] });
    await router.import(here, "" as FilePath, ["/Users/me/drop.txt"]);
    expect(calls).toEqual(["remote import mini  /Users/me/drop.txt", "local import"]);
  });
});
