import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import {
  BROWSER_AUTOMATION_HERDR_AGENTS,
  IPC_CHANNELS,
  type BrowserAutomationEnableInput,
  type BrowserAutomationSummary,
} from "../src/shared/ipc";
import { formatNodeRef } from "../src/shared/node-ref";
import {
  registerBrowserAgentIpc,
  type BrowserAutomationIpcService,
} from "../src/main/vellum/browser/agent-ipc";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: ReadonlyArray<unknown>
) => unknown;

const PAGE_REF = formatNodeRef({ canvasName: "work", nodeId: "page/1" });
const AUTOMATION_ID = "00000000-0000-4000-8000-000000000001";

const summaryFor = (input: BrowserAutomationEnableInput): BrowserAutomationSummary =>
  input.kind === "hermes"
    ? {
        automationId: AUTOMATION_ID,
        kind: "hermes",
        ref: input.ref,
        issuedAt: 1_000,
        expiresAt: 2_000,
      }
    : {
        automationId: AUTOMATION_ID,
        kind: "herdr",
        ref: input.ref,
        agent: input.agent,
        issuedAt: 1_000,
        expiresAt: 2_000,
      };

describe("trusted-renderer browser automation IPC", () => {
  const handlers = new Map<string, InvokeHandler>();
  const mainFrame = {} as WebFrameMain;
  const trustedContents = { mainFrame } as WebContents;
  const trustedEvent = {
    sender: trustedContents,
    senderFrame: mainFrame,
  } as IpcMainInvokeEvent;
  const enable = vi.fn(async (input: BrowserAutomationEnableInput) => ({
    ok: true as const,
    data: summaryFor(input),
  }));
  const list = vi.fn(async () => ({
    ok: true as const,
    data: [] as ReadonlyArray<BrowserAutomationSummary>,
  }));
  const revoke = vi.fn(async (_automationId: string) => ({
    ok: true as const,
    data: { revoked: true as const },
  }));
  const trustedSender = vi.fn(
    (event: IpcMainInvokeEvent) => event.sender === trustedContents,
  );

  beforeEach(() => {
    handlers.clear();
    enable.mockReset();
    list.mockReset();
    revoke.mockReset();
    trustedSender.mockReset();
    enable.mockImplementation(async (input) => ({ ok: true, data: summaryFor(input) }));
    list.mockResolvedValue({ ok: true, data: [] });
    revoke.mockResolvedValue({ ok: true, data: { revoked: true } });
    trustedSender.mockImplementation((event) => event.sender === trustedContents);

    const ipcMain = {
      handle: vi.fn((channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    const service: BrowserAutomationIpcService = { enable, list, revoke };
    registerBrowserAgentIpc(ipcMain, service, trustedSender);
  });

  const invoke = async (
    channel: string,
    event: IpcMainInvokeEvent,
    ...args: ReadonlyArray<unknown>
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`${channel} handler not registered`);
    return handler(event, ...args);
  };

  const expectNoServiceCalls = (): void => {
    expect(enable).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  };

  it("copies exact Hermes and allowlisted local Herdr enable inputs", async () => {
    const hermesInput = { kind: "hermes" as const, ref: PAGE_REF };
    const hermes = await invoke(
      IPC_CHANNELS.browserAutomationEnable,
      trustedEvent,
      hermesInput,
    );
    expect(enable).toHaveBeenNthCalledWith(1, hermesInput);
    expect(enable.mock.calls[0]?.[0]).not.toBe(hermesInput);
    expect(hermes).toEqual({ ok: true, data: summaryFor(hermesInput) });

    const herdrInput = { kind: "herdr" as const, ref: PAGE_REF, agent: "codex" as const };
    const herdr = await invoke(
      IPC_CHANNELS.browserAutomationEnable,
      trustedEvent,
      herdrInput,
    );
    expect(enable).toHaveBeenNthCalledWith(2, herdrInput);
    expect(enable.mock.calls[1]?.[0]).not.toBe(herdrInput);
    expect(herdr).toEqual({ ok: true, data: summaryFor(herdrInput) });
  });

  it.each(BROWSER_AUTOMATION_HERDR_AGENTS)(
    "accepts the fixed local Herdr agent %s",
    async (agent) => {
      const input = { kind: "herdr" as const, ref: PAGE_REF, agent };

      await expect(
        invoke(IPC_CHANNELS.browserAutomationEnable, trustedEvent, input),
      ).resolves.toEqual({ ok: true, data: summaryFor(input) });
      expect(enable).toHaveBeenCalledWith(input);
    },
  );

  it("registers list and canonical-id revoke without exposing internal identifiers", async () => {
    list.mockResolvedValue({
      ok: true,
      data: [summaryFor({ kind: "hermes", ref: PAGE_REF })],
    });

    const listed = await invoke(IPC_CHANNELS.browserAutomationList, trustedEvent);
    const revoked = await invoke(
      IPC_CHANNELS.browserAutomationRevoke,
      trustedEvent,
      AUTOMATION_ID,
    );

    expect(list).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(AUTOMATION_ID);
    expect(listed).toEqual({
      ok: true,
      data: [summaryFor({ kind: "hermes", ref: PAGE_REF })],
    });
    expect(revoked).toEqual({ ok: true, data: { revoked: true } });
    for (const forbidden of [
      "capability",
      "controlHome",
      "ownerId",
      "principalId",
      "jobId",
      "auditId",
    ]) {
      expect(JSON.stringify([listed, revoked])).not.toContain(forbidden);
    }
  });

  it("rejects untrusted, detached, and subframe senders before service access", async () => {
    const otherMainFrame = {} as WebFrameMain;
    const otherContents = { mainFrame: otherMainFrame } as WebContents;
    const events = [
      { sender: otherContents, senderFrame: otherMainFrame } as IpcMainInvokeEvent,
      { sender: trustedContents, senderFrame: null } as IpcMainInvokeEvent,
      { sender: trustedContents, senderFrame: {} as WebFrameMain } as IpcMainInvokeEvent,
    ];

    for (const event of events) {
      await expect(
        invoke(IPC_CHANNELS.browserAutomationEnable, event, {
          kind: "hermes",
          ref: PAGE_REF,
        }),
      ).resolves.toEqual({ ok: false, code: "invalid" });
    }
    expectNoServiceCalls();
  });

  it("fails closed when the explicit trusted-sender predicate throws", async () => {
    trustedSender.mockImplementation(() => {
      throw new Error("predicate failure");
    });

    await expect(
      invoke(IPC_CHANNELS.browserAutomationList, trustedEvent),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expectNoServiceCalls();
  });

  it.each([
    ["missing argument", []],
    ["surplus argument", [{ kind: "hermes", ref: PAGE_REF }, "surplus"]],
  ])("rejects %s before enable service access", async (_label, args) => {
    await expect(
      invoke(IPC_CHANNELS.browserAutomationEnable, trustedEvent, ...args),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expectNoServiceCalls();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing ref", { kind: "hermes" }],
    ["invalid kind", { kind: "shell", ref: PAGE_REF }],
    ["Hermes agent field", { kind: "hermes", ref: PAGE_REF, agent: "codex" }],
    ["Herdr missing agent", { kind: "herdr", ref: PAGE_REF }],
    ["unlisted Herdr agent", { kind: "herdr", ref: PAGE_REF, agent: "bash" }],
    ["noncanonical ref", { kind: "hermes", ref: "vellum://canvas/work?node=page%2f1" }],
    ["oversized ref", { kind: "hermes", ref: "x".repeat(4_097) }],
    ["caller TTL", { kind: "hermes", ref: PAGE_REF, ttlMs: 1 }],
    ["caller actions", { kind: "hermes", ref: PAGE_REF, actions: ["open"] }],
    ["caller scope", { kind: "hermes", ref: PAGE_REF, scope: "all" }],
    ["caller origin", { kind: "hermes", ref: PAGE_REF, origin: "https://example.com" }],
    ["caller profile", { kind: "hermes", ref: PAGE_REF, profile: "default" }],
    ["caller subject", { kind: "hermes", ref: PAGE_REF, subject: "operator" }],
  ])("rejects %s input generically before enable", async (_label, input) => {
    await expect(
      invoke(IPC_CHANNELS.browserAutomationEnable, trustedEvent, input),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expectNoServiceCalls();
  });

  it("rejects list arguments before service access", async () => {
    await expect(
      invoke(IPC_CHANNELS.browserAutomationList, trustedEvent, "surplus"),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expectNoServiceCalls();
  });

  it.each([
    ["missing", []],
    ["surplus", [AUTOMATION_ID, "surplus"]],
    ["empty", [""]],
    ["non-string", [42]],
    ["uppercase", ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]],
    ["wrong UUID version", ["00000000-0000-1000-8000-000000000001"]],
    ["oversized", ["x".repeat(257)]],
  ])("rejects %s revoke id generically", async (_label, args) => {
    await expect(
      invoke(IPC_CHANNELS.browserAutomationRevoke, trustedEvent, ...args),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expectNoServiceCalls();
  });

  it("sanitizes service failures and rejects secret-bearing success payloads", async () => {
    enable
      .mockResolvedValueOnce({ ok: false, code: "not_found" } as never)
      .mockResolvedValueOnce({
        ok: false,
        code: "not_found",
        message: "capability=do-not-leak",
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ...summaryFor({ kind: "hermes", ref: PAGE_REF }),
          capability: "do-not-leak",
          ownerId: "owner-internal",
        },
      } as never);

    const safeFailure = await invoke(
      IPC_CHANNELS.browserAutomationEnable,
      trustedEvent,
      { kind: "hermes", ref: PAGE_REF },
    );
    const malformedFailure = await invoke(
      IPC_CHANNELS.browserAutomationEnable,
      trustedEvent,
      { kind: "hermes", ref: PAGE_REF },
    );
    const secretSuccess = await invoke(
      IPC_CHANNELS.browserAutomationEnable,
      trustedEvent,
      { kind: "hermes", ref: PAGE_REF },
    );

    expect(safeFailure).toEqual({ ok: false, code: "not_found" });
    expect(malformedFailure).toEqual({ ok: false, code: "delivery_failed" });
    expect(secretSuccess).toEqual({ ok: false, code: "delivery_failed" });
    expect(JSON.stringify([safeFailure, malformedFailure, secretSuccess]))
      .not.toContain("do-not-leak");
  });

  it("rejects secret-bearing list and revoke service payloads", async () => {
    list.mockResolvedValue({
      ok: true,
      data: [{
        ...summaryFor({ kind: "hermes", ref: PAGE_REF }),
        auditId: "audit-internal",
      }],
    } as never);
    revoke.mockResolvedValue({
      ok: true,
      data: { revoked: true, controlHome: "/secret/home" },
    } as never);

    const listed = await invoke(IPC_CHANNELS.browserAutomationList, trustedEvent);
    const revoked = await invoke(
      IPC_CHANNELS.browserAutomationRevoke,
      trustedEvent,
      AUTOMATION_ID,
    );

    expect(listed).toEqual({ ok: false, code: "delivery_failed" });
    expect(revoked).toEqual({ ok: false, code: "delivery_failed" });
    expect(JSON.stringify([listed, revoked])).not.toContain("audit-internal");
    expect(JSON.stringify([listed, revoked])).not.toContain("/secret/home");
  });
});
