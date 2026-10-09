import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { relayMachineLink } from "../src/cli/link";

let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it("relays both directions verbatim, including the core's final bytes after stdin ends", async () => {
  directory = await mkdtemp(join(tmpdir(), "junto-link-"));
  const path = join(directory, "control.sock");
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.write('hello\n');
    socket.on("data", bytes => socket.write(bytes));
    socket.on("end", () => socket.end('finished\n'));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", chunk => chunks.push(chunk));
    const finished = relayMachineLink(path, input, output);
    input.end(Buffer.from([0x00, 0xff, 0x0a]));
    await finished;
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from('hello\n'), Buffer.from([0x00, 0xff, 0x0a]), Buffer.from('finished\n')]));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("reports a missing core without emitting protocol bytes", async () => {
  directory = await mkdtemp(join(tmpdir(), "junto-link-"));
  const output = new PassThrough();
  let wrote = false;
  output.on("data", () => { wrote = true; });
  await expect(relayMachineLink(join(directory, "absent.sock"), new PassThrough(), output)).rejects.toThrow();
  expect(wrote).toBe(false);
});
