import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TermControlClient,
  TermControlTransportUncertainError,
} from "../src/main/vellum-command/term/control-client";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";
import { TERM_CONTROL_PROTOCOL } from "../src/shared/term-control";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const submitted: ManagedPromptOutcome = {
  status: "submitted",
  bindingGeneration: 2,
  writesBefore: 3,
  writesAfter: 4,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
};

const refused: ManagedPromptOutcome = {
  status: "refused",
  reason: "seat-busy",
  bindingGeneration: 2,
  writesBefore: 4,
  writesAfter: 4,
  pasteWrites: 0,
  wrotePhysicalBytes: false,
};

/** A real NDJSON socket, with only the destination receipt under test faked. */
const connectToReceipt = async (
  data: unknown,
  envelope: Readonly<Record<string, unknown>> = {},
) => {
  const home = mkdtempSync(join(tmpdir(), "vco-"));
  const socketPath = join(home, "control.sock");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const requests: Array<Record<string, unknown>> = [];
  const tokens: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as Record<string, unknown>;
        if (!authenticated) {
          tokens.push(request.token);
          authenticated = true;
          socket.write(`${JSON.stringify({ v: TERM_CONTROL_PROTOCOL, id: "auth", ok: true })}\n`);
          continue;
        }
        requests.push(request);
        socket.write(`${JSON.stringify({ v: TERM_CONTROL_PROTOCOL, id: request.id, ok: true, data, ...envelope })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  const client = await TermControlClient.connect({
    socketPath,
    token: "owned-outcome-test",
    timeoutMs: 1_000,
  });
  cleanups.push(async () => {
    client.close();
    await client.whenClosed();
  });
  expect(tokens).toEqual(["owned-outcome-test"]);
  return { client, requests };
};

const expectSinglePrompt = (requests: Array<Record<string, unknown>>) => {
  expect(requests).toEqual([{
    v: TERM_CONTROL_PROTOCOL,
    id: expect.any(String),
    op: "managedPrompt",
    bindingId: "binding-a",
    text: "hello",
    queueIfBusy: false,
  }]);
};

describe("managed prompt receipts over term control UDS", () => {
  it.each([
    { outcome: submitted, accepted: true },
    { outcome: refused, accepted: false },
  ])("maps $outcome.status to $accepted", async ({ outcome, accepted }) => {
    const { client, requests } = await connectToReceipt(outcome);
    await expect(client.managedPrompt("binding-a", "hello")).resolves.toBe(accepted);
    expectSinglePrompt(requests);
  });

  it.each<ManagedPromptOutcome>([
    { ...submitted, status: "unresolved", reason: "no-turn-start" },
    { ...submitted, status: "unresolved", reason: "chip-pending" },
    { ...refused, status: "refused", reason: "written-unresolved" },
  ])("keeps $status/$reason uncertain without repasting", async (outcome) => {
    const { client, requests } = await connectToReceipt(outcome);
    await expect(client.managedPrompt("binding-a", "hello")).rejects.toBeInstanceOf(
      TermControlTransportUncertainError,
    );
    expectSinglePrompt(requests);
  });

  it.each([
    { label: "legacy true", data: true },
    { label: "legacy false", data: false },
    { label: "arbitrary truthy object", data: { delivered: true } },
    { label: "array", data: [] },
    { label: "null", data: null },
    { label: "missing write facts", data: { status: "submitted" } },
    { label: "unknown status", data: { ...submitted, status: "accepted" } },
    { label: "unknown refusal reason", data: { ...refused, reason: "unknown" } },
    { label: "negative generation", data: { ...submitted, bindingGeneration: -1 } },
    { label: "string counter", data: { ...submitted, writesAfter: "4" } },
    { label: "fractional counter", data: { ...submitted, pasteWrites: 0.5 } },
    { label: "reversed counters", data: { ...submitted, writesBefore: 5 } },
    { label: "contradictory write delta", data: { ...submitted, pasteWrites: 2 } },
  ])("treats $label as uncertain instead of a receipt", async ({ data }) => {
    const { client, requests } = await connectToReceipt(data);
    await expect(client.managedPrompt("binding-a", "hello")).rejects.toMatchObject({
      name: "TermControlTransportUncertainError",
      message: "destination returned an invalid managed prompt receipt",
    });
    expectSinglePrompt(requests);
  });

  it.each([
    { label: "truthy string", ok: "true" },
    { label: "truthy object", ok: {} },
    { label: "missing flag", ok: undefined },
  ])("keeps a malformed $label envelope uncertain", async ({ ok }) => {
    const { client, requests } = await connectToReceipt(submitted, { ok });
    await expect(client.managedPrompt("binding-a", "hello")).rejects.toBeInstanceOf(
      TermControlTransportUncertainError,
    );
    expectSinglePrompt(requests);
  });
});
