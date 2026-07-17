import { describe, expect, it, vi } from "vitest";
import {
  HerdrAgentDeliveryError,
  SUPPORTED_HERDR_BROWSER_AGENTS,
  startLocalHerdrBrowserAgent,
  type LocalHerdrBrowserAgentStart,
  type SupportedHerdrBrowserAgent,
} from "../src/main/vellum/browser/herdr-agent-delivery";
import { LocalMirrorTransport } from "../src/main/vellum/herdr/mirror-transport";
import {
  CONTROL_CAPABILITY_ENV,
  CONTROL_HOME_ENV,
} from "../src/shared/browser-control";

const CAPABILITY = "c".repeat(43);

interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
  readonly timeoutMs: number | undefined;
}

class RecordingLocalTransport extends LocalMirrorTransport {
  readonly calls: RecordedRequest[] = [];

  constructor(
    private readonly respond: (
      method: string,
      params: unknown,
      timeoutMs: number | undefined,
    ) => unknown | Promise<unknown>,
  ) {
    super("/tmp/vellum-herdr-agent-delivery-test.sock");
  }

  override async request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    return this.respond(method, params, timeoutMs);
  }
}

const inputFor = (
  agent: SupportedHerdrBrowserAgent = "codex",
): LocalHerdrBrowserAgentStart => ({
  agent,
  capability: CAPABILITY,
  controlHome: "/Users/tester",
  cwd: "/Users/tester/Projects/vellum",
});

const startedResponse = (
  executable = "codex",
  agentOverrides: Record<string, unknown> = {},
): unknown => ({
  type: "agent_started",
  argv: [executable],
  agent: {
    terminal_id: "term_1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    agent_status: "working",
    focused: false,
    revision: 1,
    ...agentOverrides,
  },
});

const expectDeliveryError = async (
  promise: Promise<unknown>,
  code: HerdrAgentDeliveryError["code"],
): Promise<HerdrAgentDeliveryError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HerdrAgentDeliveryError);
    const deliveryError = error as HerdrAgentDeliveryError;
    expect(deliveryError.code).toBe(code);
    expect(deliveryError.message).toBe("local Herdr browser-agent delivery failed");
    expect((deliveryError as Error & { cause?: unknown }).cause).toBeUndefined();
    return deliveryError;
  }
  throw new Error("expected HerdrAgentDeliveryError");
};

describe("local Herdr browser-agent delivery", () => {
  it.each(SUPPORTED_HERDR_BROWSER_AGENTS)(
    "maps the fixed %s allowlist entry to an exact stock agent.start request",
    async (agent) => {
      const transport = new RecordingLocalTransport(() => startedResponse(agent));

      const result = await startLocalHerdrBrowserAgent(transport, {
        ...inputFor(agent),
        workspaceId: "w1",
        tabId: "w1:t1",
      });

      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]).toEqual({
        method: "agent.start",
        timeoutMs: 15_000,
        params: {
          name: agent,
          argv: [agent],
          cwd: "/Users/tester/Projects/vellum",
          env: {
            [CONTROL_CAPABILITY_ENV]: CAPABILITY,
            [CONTROL_HOME_ENV]: "/Users/tester",
          },
          focus: false,
          workspace_id: "w1",
          tab_id: "w1:t1",
        },
      });
      const params = transport.calls[0]?.params as {
        argv: string[];
        env: Record<string, string>;
      };
      expect(Object.keys(params.env).sort()).toEqual(
        [CONTROL_CAPABILITY_ENV, CONTROL_HOME_ENV].sort(),
      );
      expect(Object.isFrozen(params)).toBe(true);
      expect(Object.isFrozen(params.argv)).toBe(true);
      expect(Object.isFrozen(params.env)).toBe(true);
      expect(JSON.stringify(transport.calls[0]).split(CAPABILITY)).toHaveLength(2);
      expect(result).toEqual({
        terminalId: "term_1",
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
      });
      expect(Object.keys(result).sort()).toEqual(
        ["paneId", "tabId", "terminalId", "workspaceId"].sort(),
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(CAPABILITY);
    },
  );

  it("omits optional Herdr placement rather than synthesizing renderer-controlled values", async () => {
    const transport = new RecordingLocalTransport(() => startedResponse());

    await startLocalHerdrBrowserAgent(transport, inputFor());

    const params = transport.calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("workspace_id");
    expect(params).not.toHaveProperty("tab_id");
    expect(params).not.toHaveProperty("split");
  });

  it.each([
    ["unsupported agent", { ...inputFor(), agent: "bash" }],
    ["invalid capability", { ...inputFor(), capability: "not-a-capability" }],
    ["relative home", { ...inputFor(), controlHome: "Users/tester" }],
    ["noncanonical cwd", { ...inputFor(), cwd: "/Users/tester/../tester/project" }],
    ["control character in cwd", { ...inputFor(), cwd: "/Users/tester/project\nnext" }],
    ["tab without workspace", { ...inputFor(), tabId: "w1:t1" }],
    ["invalid workspace", { ...inputFor(), workspaceId: "w1/other" }],
    ["capability in placement", { ...inputFor(), workspaceId: CAPABILITY }],
    ["caller-supplied argv", { ...inputFor(), argv: ["sh", "-c", "env"] }],
    ["caller-supplied env", { ...inputFor(), env: { EXTRA: "value" } }],
  ])("rejects %s before invoking Herdr", async (_label, candidate) => {
    const transport = new RecordingLocalTransport(() => startedResponse());

    const error = await expectDeliveryError(
      startLocalHerdrBrowserAgent(
        transport,
        candidate as unknown as LocalHerdrBrowserAgentStart,
      ),
      "invalid_input",
    );

    expect(transport.calls).toHaveLength(0);
    expect(String(error)).not.toContain(CAPABILITY);
    expect(error.stack).not.toContain(CAPABILITY);
  });

  it("rejects non-local and structurally forged transports without invoking them", async () => {
    const request = vi.fn(async () => startedResponse());
    const forged = { request } as unknown as LocalMirrorTransport;

    await expectDeliveryError(
      startLocalHerdrBrowserAgent(forged, inputFor()),
      "local_transport_required",
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("discards transport errors without logging or relaying their text", async () => {
    const transport = new RecordingLocalTransport(() => {
      throw new Error(`Herdr echoed ${CAPABILITY}`);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const error = await expectDeliveryError(
        startLocalHerdrBrowserAgent(transport, inputFor()),
        "transport_failed",
      );
      expect(String(error)).not.toContain(CAPABILITY);
      expect(error.stack).not.toContain(CAPABILITY);
      expect(JSON.stringify(error)).not.toContain(CAPABILITY);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it.each([
    ["null", null],
    ["wrong result type", { ...startedResponse() as object, type: "agent_info" }],
    ["unexpected top-level field", { ...startedResponse() as object, env: {} }],
    ["wrong argv", startedResponse("sh")],
    ["extra argv", { ...startedResponse() as object, argv: ["codex", "--yolo"] }],
    ["missing required identity", startedResponse("codex", { terminal_id: undefined })],
    ["unsafe revision", startedResponse("codex", { revision: Number.MAX_SAFE_INTEGER + 1 })],
    ["invalid identifier", startedResponse("codex", { pane_id: "pane/1" })],
    ["secret identifier", startedResponse("codex", { terminal_id: CAPABILITY })],
    ["invalid optional field", startedResponse("codex", { state_labels: [] })],
    ["oversized response", startedResponse("codex", { title: "x".repeat(20_000) })],
  ])("rejects a malformed or non-secret-safe agent_started response: %s", async (_label, response) => {
    const transport = new RecordingLocalTransport(() => response);

    const error = await expectDeliveryError(
      startLocalHerdrBrowserAgent(transport, inputFor()),
      "malformed_response",
    );

    expect(String(error)).not.toContain(CAPABILITY);
    expect(error.stack).not.toContain(CAPABILITY);
  });

  it("rejects cyclic and accessor-bearing responses without invoking accessors", async () => {
    const cyclic = startedResponse() as Record<string, unknown>;
    cyclic.loop = cyclic;
    let getterInvoked = false;
    const accessorResponse = startedResponse() as Record<string, unknown>;
    Object.defineProperty(accessorResponse, "hidden", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return CAPABILITY;
      },
    });

    for (const response of [cyclic, accessorResponse]) {
      const transport = new RecordingLocalTransport(() => response);
      await expectDeliveryError(
        startLocalHerdrBrowserAgent(transport, inputFor()),
        "malformed_response",
      );
    }
    expect(getterInvoked).toBe(false);
  });

  it("rejects accessor-bearing input without invoking the accessor", async () => {
    let getterInvoked = false;
    const input = inputFor() as LocalHerdrBrowserAgentStart & Record<string, unknown>;
    Object.defineProperty(input, "argv", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return ["sh"];
      },
    });
    const transport = new RecordingLocalTransport(() => startedResponse());

    await expectDeliveryError(
      startLocalHerdrBrowserAgent(transport, input),
      "invalid_input",
    );

    expect(getterInvoked).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });
});
