/**
 * A link key's forced command runs `junto link --opener <id>`: the relay
 * writes one opener line before any byte from the far end, and the core
 * admits only a hello from that installation (docs/machines.md, The link).
 */
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { relayMachineLink } from "../src/cli/link";
import { makeLinkSession } from "../src/main/junto/link/session";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import type { LinkHello } from "../src/main/junto/link/types";
import { InstallationId } from "../src/shared/installation-id";

const BUILD = "d".repeat(64);
const hello = (name: string) => Schema.decodeUnknownSync(LinkHelloSchema)({ machineName: name, installationId: `${name}-install`, build: BUILD });
const id = Schema.decodeUnknownSync(InstallationId);
const opened: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of opened.splice(0)) await close(); });

/**
 * The accepting end reads `first` and then whatever the dialer writes, as a
 * relay hands the core its own line and then the SSH session's bytes.
 */
const accept = (first: ReadonlyArray<string>, dialerSends: (stream: PassThrough) => void = () => undefined) => {
  const toAccepted = new PassThrough();
  const toDialer = new PassThrough();
  const fromDialer = new PassThrough();
  for (const line of first) toAccepted.write(`${line}\n`);
  dialerSends(toAccepted);
  fromDialer.pipe(toAccepted);
  const admitted: Array<{ hello: LinkHello; opener: InstallationId | undefined }> = [];
  const accepted = makeLinkSession({ readable: toAccepted, writable: toDialer, self: hello("vps"), channels: {}, run: Effect.runPromise,
    acceptsOpener: true, admit: async (peer, opener) => { admitted.push({ hello: peer, opener }); } });
  const dialer = makeLinkSession({ readable: toDialer, writable: fromDialer, self: hello("mini"), channels: {}, run: Effect.runPromise, admit: async () => {} });
  opened.push(async () => { await Promise.all([accepted.close(), dialer.close()]); });
  return { accepted, dialer, admitted };
};
const opener = (installationId: string) => JSON.stringify({ type: "opener", installationId });

it("admits the hello of the installation the relay named, and tells admission which key it came through", async () => {
  const { accepted, admitted } = accept([opener("mini-install")]);
  expect((await accepted.ready).installationId).toBe("mini-install");
  expect(admitted[0]?.opener).toBe(id("mini-install"));
});

it("refuses a hello from another installation than the key's opener, naming the machine", async () => {
  const { accepted } = accept([opener("editor-install")]);
  await expect(accepted.ready).rejects.toMatchObject({ _tag: "LinkHelloRefused", check: "opener-key", machine: "mini" });
});

it("refuses an opener line the far end sends after the relay's", async () => {
  const { accepted } = accept([opener("mini-install"), opener("editor-install")]);
  await expect(accepted.ready).rejects.toMatchObject({ _tag: "LinkHelloRefused", check: "opener" });
});

it("refuses an opener line after the hello", async () => {
  const { accepted } = accept([], (stream) => {
    stream.write(`${JSON.stringify({ type: "hello", ...hello("mini") })}\n${opener("mini-install")}\n`);
  });
  const closed = await accepted.closed;
  expect(closed.causes[0]).toMatchObject({ tag: "LinkHelloRefused" });
});

it("refuses an opener line on a link this end dialed", async () => {
  const toDialer = new PassThrough();
  const dialer = makeLinkSession({ readable: toDialer, writable: new PassThrough(), self: hello("mini"), channels: {}, run: Effect.runPromise, admit: async () => {} });
  opened.push(async () => { await dialer.close(); });
  toDialer.write(`${opener("vps-install")}\n`);
  await expect(dialer.ready).rejects.toMatchObject({ _tag: "LinkHelloRefused", check: "opener" });
});

it("refuses an opener line that does not decode closed", async () => {
  const { accepted } = accept([JSON.stringify({ type: "opener", installationId: "mini-install", key: "extra" })]);
  await expect(accepted.ready).rejects.toMatchObject({ _tag: "LinkFrameInvalid" });
});

it("leaves admission without an opener when the relay named none", async () => {
  const { accepted, admitted } = accept([]);
  await accepted.ready;
  expect(admitted[0]?.opener).toBeUndefined();
});

let directory: string | undefined;
afterEach(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); directory = undefined; });

it("writes the opener line before any byte from the far end", async () => {
  directory = await mkdtemp(join(tmpdir(), "junto-link-opener-"));
  const path = join(directory, "control.sock");
  const received: Buffer[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", (bytes: Buffer) => received.push(bytes));
    socket.on("end", () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const input = new PassThrough();
    input.write("far end bytes\n");
    const finished = relayMachineLink(path, input, new PassThrough(), id("mini-install"));
    input.end();
    await finished;
    expect(Buffer.concat(received).toString()).toBe(`${opener("mini-install")}\nfar end bytes\n`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
