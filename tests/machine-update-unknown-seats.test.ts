/**
 * The refusal that says an older machine could not count its seats crosses
 * the owner contract and reaches the window's confirm. Main's RPC client
 * decodes every answer against the owner envelope before the window sees it,
 * so a detail the contract does not name never reaches the confirm.
 */
import { Result } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse } from "../src/shared/operator-control";
import { answerConfirm, confirm$ } from "../src/window/lib/confirm";
import { machines$, requestMachineUpdate } from "../src/window/lib/machines-actions";
import type { MachineListItem } from "../src/window/lib/machines-view";
import { OTHER_MACHINE } from "./support/machines";

const item = {
  machine: {
    id: OTHER_MACHINE,
    label: "Atlas",
    isThisMachine: false,
    capabilities: ["terminal"],
    sshEndpoint: "op@atlas",
  },
  setUp: true,
  needsUpdate: true,
  installationId: `inst-${OTHER_MACHINE}`,
} as unknown as MachineListItem;

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  machines$.copies.set({});
  confirm$.pending.set(null);
});

afterEach(() => {
  if (confirm$.pending.peek() !== null) answerConfirm(false);
  vi.unstubAllGlobals();
});

const refusal = (request: { readonly id: string; readonly op: string }) => ({
  protocol: OPERATOR_PROTOCOL_VERSION,
  id: request.id,
  op: request.op,
  ok: false,
  error: {
    type: "io",
    message: "This machine's Junto did not say how many seats it runs",
    details: { retryable: true, disposition: "staged", transitions: [], runningSeatsUnknown: true },
  },
}) as const;

it("carries the unknown running-seat refusal through the owner contract to the confirm", async () => {
  // What main's RPC client does with the core's answer before the window sees it.
  const sample = decodeOperatorResponse(refusal({ id: "window-update-1", op: "machine.update" }));
  expect(Result.isSuccess(sample)).toBe(true);
  vi.stubGlobal("window", { junto: { machineCommand: vi.fn(async (request: { readonly id: string; readonly op: string }) => {
    const decoded = decodeOperatorResponse(refusal(request));
    if (Result.isFailure(decoded)) throw new Error(String(decoded.failure));
    return decoded.success;
  }) } });

  const asked = requestMachineUpdate(item);
  await flush();
  expect(confirm$.pending.peek()).toMatchObject({
    source: "machine-update-running-seats",
    title: "Update Atlas now?",
    body: ["Could not check whether seats are running on Atlas. Updating will stop any running seats."],
    confirmLabel: "Update now",
  });
  answerConfirm(false);
  await expect(asked).resolves.toBe(false);
});
