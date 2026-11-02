/**
 * A real Codex seat reaches Junto from inside Codex's own sandbox
 * [real-harness, opt-in].
 *   JUNTO_REAL_CODEX_SOCKET=1 bun run test:e2e:fast e2e/scenarios/codex-sandbox-work-socket.spec.ts
 *
 * Codex applies its `:workspace` permission profile by default, and that
 * profile denies every AF_UNIX connect: without an allowance, `junto` in a
 * seat dies with `connect EPERM` on the work control socket (task #602). This
 * runs the real codex binary in the real app against a fake model provider
 * that asks it to run `junto ping`, `junto onboard` and `junto offboard`, and
 * asserts each command reached the running app from inside the sandbox.
 *
 * The model is fake; everything under it is real: the codex binary, its
 * sandbox, Junto's work socket, the seat's generation credential, and the
 * app's work plane. The seat's cwd is throwaway and CODEX_HOME is a throwaway
 * config that names the local provider, so the operator's ~/.codex is never
 * read or written.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import type { TerminalSessionSummary } from "../../src/shared/terminal";
import { seatParts } from "../../src/shared/model/seat-parts";
import { THIS_MACHINE } from "../../tests/support/machines";
import { expect, launchJunto, test } from "../harness/launch";
import { crewPlayFactory } from "../harness/crew-fixture";
import { modelFixture, modelNode } from "../harness/model";

const OPT_IN = process.env.JUNTO_REAL_CODEX_SOCKET?.trim() === "1";
const CANVAS = "codex-sandbox-proof";

const which = (binary: string): string | undefined => {
  try {
    return execFileSync("/usr/bin/which", [binary], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};

const versionOf = (binary: string): string => {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 20_000 })
      .trim()
      .split("\n")[0]!
      .slice(0, 120);
  } catch {
    return "unknown";
  }
};

/** One shell command the fake model asks the seat to run, and its output. */
type Run = { readonly command: string; readonly output?: string };

type FakeModel = {
  readonly baseUrl: string;
  /** The command the next turn asks for. */
  setCommand: (command: string) => void;
  /** Every command asked for, with the sandboxed output once it came back. */
  readonly runs: Run[];
  readonly close: () => Promise<void>;
};

type FakeInputItem = {
  readonly type?: string;
  readonly role?: string;
  readonly call_id?: string;
  readonly output?: unknown;
  readonly content?: ReadonlyArray<{ readonly text?: string }>;
};

/**
 * A Responses-API server with no model behind it: it answers each turn with
 * one `exec_command` call for the command the test set, and records that
 * call's sandboxed output when Codex sends it back. Only the model is fake.
 * Every call gets its own ids: a reused call id makes Codex answer the second
 * turn with "unsupported call".
 */
const startFakeModel = async (): Promise<FakeModel> => {
  const runs: Run[] = [];
  const byCall = new Map<string, number>();
  const answered = new Set<string>();
  let next = "";
  let calls = 0;
  const send = (res: import("node:http").ServerResponse, events: readonly object[]): void => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of events) res.write(`event: ${String((event as { type: string }).type)}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", created: 0, owned_by: "fake" }] }));
        return;
      }
      if (req.url !== "/v1/responses") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      let input: ReadonlyArray<FakeInputItem> = [];
      let tools: ReadonlyArray<string> = [];
      try {
        const parsed = JSON.parse(body) as { input?: ReadonlyArray<FakeInputItem>; tools?: ReadonlyArray<{ name?: string; type?: string }> };
        input = parsed.input ?? [];
        tools = (parsed.tools ?? []).map((tool) => tool.name ?? tool.type ?? "");
        const lastUserText = [...input]
          .reverse()
          .find((item) => item.role === "user" && item.content !== undefined);
        writeFileSync(
          "/tmp/codex-sandbox-model.log",
          `${JSON.stringify({ tools: tools.length, input: input.map((item) => item.type ?? item.role), asked: (lastUserText?.content ?? []).map((part) => (part.text ?? "").slice(0, 60)).join(" | ") })}\n`,
          { flag: "a" },
        );
      } catch {
        // A body the fake cannot read still gets a final answer.
      }
      // History keeps every earlier tool result, so only an id not seen before
      // is this turn's answer.
      const results = input.filter(
        (item) =>
          item.call_id !== undefined &&
          item.output !== undefined &&
          !answered.has(item.call_id),
      );
      for (const result of results) {
        answered.add(result.call_id!);
        const at = byCall.get(result.call_id!);
        if (at !== undefined) {
          runs[at] = { ...runs[at]!, output: String(result.output ?? "") };
        }
      }
      if (results.length > 0) {
        const message = { id: `msg_${String(calls)}`, type: "message", status: "in_progress", role: "assistant", content: [] };
        const done = { ...message, status: "completed", content: [{ type: "output_text", text: "done" }] };
        send(res, [
          { type: "response.created", response: { id: `resp_done_${String(calls)}`, object: "response", created_at: 0, status: "in_progress", model: "fake-model", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: message },
          { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "done" },
          { type: "response.output_item.done", output_index: 0, item: done },
          { type: "response.completed", response: { id: `resp_done_${String(calls)}`, object: "response", created_at: 0, status: "completed", model: "fake-model", output: [done] } },
        ]);
        return;
      }
      // The prompt is one user message among the seat's mail; any of them may
      // carry the test's marker, and the last one is not always ours.
      const asked = input
        .filter((item) => item.role === "user")
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join(" ");
      if (!asked.includes("RUN") || !tools.includes("exec_command")) {
        // Not one of the test's own turns (the mail nudge, a startup turn): no
        // tool call. The TUI's first turn has no exec tool registered yet.
        const message = { id: `msg_idle_${String(calls)}`, type: "message", status: "in_progress", role: "assistant", content: [] };
        const done = { ...message, status: "completed", content: [{ type: "output_text", text: "ready" }] };
        send(res, [
          { type: "response.created", response: { id: `resp_idle_${String(calls)}`, object: "response", created_at: 0, status: "in_progress", model: "fake-model", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: message },
          { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "ready" },
          { type: "response.output_item.done", output_index: 0, item: done },
          { type: "response.completed", response: { id: `resp_idle_${String(calls)}`, object: "response", created_at: 0, status: "completed", model: "fake-model", output: [done] } },
        ]);
        return;
      }
      calls += 1;
      const callId = `call_${String(calls)}`;
      const itemId = `fc_${String(calls)}`;
      const command = next;
      runs.push({ command });
      byCall.set(callId, runs.length - 1);
      const args = JSON.stringify({ cmd: command, yield_time_ms: 30_000 });
      const item = { id: itemId, type: "function_call", status: "in_progress", arguments: "", call_id: callId, name: "exec_command" };
      send(res, [
        { type: "response.created", response: { id: `resp_${String(calls)}`, object: "response", created_at: 0, status: "in_progress", model: "fake-model", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: args },
        { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", arguments: args } },
        { type: "response.completed", response: { id: `resp_${String(calls)}`, object: "response", created_at: 0, status: "completed", model: "fake-model", output: [{ ...item, status: "completed", arguments: args }] } },
      ]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake model has no port");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    setCommand: (command) => {
      next = command;
    },
    runs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

type Api = {
  terminalGet: (b: string) => Promise<TerminalSessionSummary | undefined>;
  terminalAttach: (i: { bindingId: string; mode: "observe" | "control"; takeover?: boolean }) => Promise<unknown>;
  terminalRelease: (l: string) => Promise<boolean>;
  terminalWrite: (l: string, d: string) => Promise<boolean>;
  terminalManagedPrompt: (i: {
    bindingId: string;
    text: string;
    canvasName: string;
    nodeId: string;
    wake: boolean;
  }) => Promise<{ ok: boolean; disposition: string; error?: string }>;
  agentSeatStateSnapshot: () => Promise<ReadonlyArray<{ bindingId: string; state: string; reason: string }>>;
};

const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[=>78MDEc]/g;

const screenOf = async (page: Page, bindingId: string): Promise<string> => {
  const raw = await page.evaluate(async (id) => {
    const api = (window as unknown as { junto: Api }).junto;
    const attached = (await api.terminalAttach({ bindingId: id, mode: "observe" })) as {
      ok: boolean;
      lease?: { leaseId: string };
      screen?: { serialized: string };
    };
    if (!attached.ok) return "";
    if (attached.lease) await api.terminalRelease(attached.lease.leaseId);
    return attached.screen?.serialized ?? "";
  }, bindingId);
  return raw
    .replace(/\u001b\[(\d*)C/g, (_m, n: string) => " ".repeat(Number(n || "1")))
    .replace(ESCAPES, "")
    .replace(/\r/g, "");
};

const operatorKeys = async (page: Page, bindingId: string, data: string): Promise<void> => {
  await page.evaluate(
    async ([id, keys]) => {
      const api = (window as unknown as { junto: Api }).junto;
      const attached = (await api.terminalAttach({ bindingId: id!, mode: "control", takeover: true })) as {
        ok: boolean;
        lease?: { leaseId: string };
      };
      if (!attached.ok || !attached.lease) return;
      await api.terminalWrite(attached.lease.leaseId, keys!);
      await api.terminalRelease(attached.lease.leaseId);
    },
    [bindingId, data] as const,
  );
};

const TRUST_PROMPT =
  /(do you trust|trust (?:the )?(?:files|folder|this (?:folder|directory|workspace))|trust this|one you trust)/i;
const SELECTED_LINE = /^\s*[❯›>▶→]\s*(?:\d+[.)]\s*)?(.*)$/m;

test("a real Codex seat reaches Junto from inside its own sandbox", async () => {
  test.skip(!OPT_IN, "opt-in: JUNTO_REAL_CODEX_SOCKET=1");
  const binary = which("codex");
  if (binary === undefined) {
    test.skip(true, "codex not installed");
    return;
  }
  test.setTimeout(600_000);
  test.info().annotations.push({ type: "cli", description: `codex ${versionOf(binary)}` });

  const model = await startFakeModel();
  const seatDir = mkdtempSync(join(tmpdir(), "junto-codex-sandbox-seat-"));
  mkdirSync(seatDir, { recursive: true });
  const codexConfig = [
    'model = "fake-model"',
    'model_provider = "fake"',
    'approval_policy = "never"',
    "",
    "[model_providers.fake]",
    'name = "Fake"',
    `base_url = "${model.baseUrl}"`,
    'wire_api = "responses"',
    "",
  ].join("\n");

  const seatId = "codex-sandbox-proof";
  const seat = seatParts({ harness: "codex", host: THIS_MACHINE, cwd: seatDir, label: "Codex sandbox proof" });
  const bindingId = seat.bindingId;
  // Seeded before boot so this machine's own name is the seat's host (a runtime
  // install cannot resolve a host the app has not named yet).
  const fixture = modelFixture([
    modelNode({ kind: "agent", id: seatId, ...seat, overseer: false, x: 360, y: 40, width: 240, height: 96, z: 0 }),
  ]);
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    // The seat's CODEX_HOME is its own home's `.codex`, the place Junto reads
    // the session id from: a session outside it could not offboard.
    afterSeed: async (sandbox) => {
      mkdirSync(join(sandbox.homeDir, ".codex"), { recursive: true });
      writeFileSync(join(sandbox.homeDir, ".codex", "config.toml"), codexConfig);
    },
    extraEnv: {
      PATH: `${dirname(binary)}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  });
  const { page } = junto;
  const canvas = CANVAS;
  const prompt = (text: string) =>
    page.evaluate(
      async ([id, body, name, node]) =>
        (window as unknown as { junto: Api }).junto.terminalManagedPrompt({
          bindingId: id!,
          text: body!,
          canvasName: name!,
          nodeId: node!,
          wake: true,
        }),
      [bindingId, text, canvas, seatId] as const,
    );
  const state = (): Promise<string | undefined> =>
    page.evaluate(
      async (id) =>
        (await (window as unknown as { junto: Api }).junto.agentSeatStateSnapshot()).find(
          (event) => event.bindingId === id,
        )?.state,
      bindingId,
    );
  /** Answer a trust prompt if the TUI is showing one; a selected "no" steps down. */
  const answerTrust = async (screen: string): Promise<boolean> => {
    if (!TRUST_PROMPT.test(screen)) return false;
    const selected = screen.match(SELECTED_LINE)?.[1] ?? "";
    await operatorKeys(page, bindingId, /\b(no|exit|quit|cancel)\b/i.test(selected) ? "\u001b[B" : "\r");
    return true;
  };

  try {
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`.react-flow__node[data-id="${seatId}"]`)).toBeVisible({ timeout: 20_000 });
    await crewPlayFactory(page);
    // Start the seat the way opening its terminal does (Play alone does not
    // occupy a seat).
    await expect
      .poll(async () => {
        await page.evaluate(
          async ([canvasName, id]) => {
            await (window as unknown as { junto: { modelStart: (i: { canvas: string; id: string }) => Promise<unknown> } }).junto.modelStart({
              canvas: canvasName!,
              id: id!,
            });
          },
          [canvas, seatId] as const,
        ).catch(() => undefined);
        return (await page.evaluate(
          async (id) => (window as unknown as { junto: Api }).junto.terminalGet(id),
          bindingId,
        )) !== undefined;
      }, { timeout: 90_000 })
      .toBe(true);
    // Wait for the TUI to paint, answering a trust prompt on the way.
    await expect
      .poll(async () => {
        const screen = await screenOf(page, bindingId);
        if (await answerTrust(screen)) return false;
        return screen.length > 0;
      }, { timeout: 90_000 })
      .toBe(true);

    /**
     * Ask the seat for one command and wait for the sandboxed output. A prompt
     * the TUI was not ready for is re-sent; each send is one model turn.
     */
    const run = async (command: string, said: string): Promise<string> => {
      const before = model.runs.length;
      model.setCommand(command);
      const deadline = Date.now() + 180_000;
      let sent = 0;
      let sentAt = 0;
      let last = "";
      let lastOutput = "";
      while (Date.now() < deadline) {
        const answered = model.runs
          .slice(before)
          .filter((entry) => entry.command === command && entry.output !== undefined)
          .at(-1);
        if (answered !== undefined) {
          lastOutput = answered.output!;
          // A seat that has not finished its first turn has no session id yet;
          // the refusal says so and is retryable, so one more turn is the ask.
          if (!/"retryable":true/u.test(lastOutput)) return lastOutput;
        }
        if (sent < 4 && (answered === undefined || Date.now() - sentAt > 20_000)) {
          await prompt(said);
          sent += 1;
          sentAt = Date.now();
        }
        last = model.runs.at(-1)?.command ?? "";
        await page.waitForTimeout(2_000);
      }
      const screen = await screenOf(page, bindingId);
      throw new Error(
        `never saw ${JSON.stringify(command)} run (sent ${String(sent)} prompts; last ${JSON.stringify(last)}; state ${String(await state())})\n[last output]\n${lastOutput}\n[runs]\n${JSON.stringify(model.runs, null, 1)}\n[screen]\n${screen}`,
      );
    };

    // 1. A junto command from inside the seat's own sandbox.
    const ping = await run("junto ping", "RUN junto ping");
    expect(ping).toContain('"ok":true');
    expect(ping).not.toContain("EPERM");

    // 2. Onboarding: the seat's own contract, read over the same socket.
    const onboard = await run("junto onboard", "RUN junto onboard");
    expect(onboard).toContain('"ok":true');

    // 3. Offboard, the seat's own stopping point, from inside the sandbox.
    const offboard = await run('junto offboard "codex sandbox proof"', "RUN offboard");
    expect(offboard).toContain('"ok":true');
    expect(offboard).not.toContain("EPERM");
    // The seat moved on: its next session is fresh, not the offboarded one.
    await expect.poll(state, { timeout: 60_000 }).not.toBe("blocked");
    // Receipts for the run record: the sandboxed output of each command.
    for (const [command, output] of [
      ["junto ping", ping],
      ["junto onboard", onboard],
      ["junto offboard", offboard],
    ] as const) {
      const line = output.split("Output:\n")[1]?.trim() ?? output.trim();
      console.log(`[codex-sandbox] ${command}: ${line.slice(0, 300)}`);
    }
  } finally {
    await model.close().catch(() => undefined);
    await junto.close().catch(() => undefined);
  }
});
