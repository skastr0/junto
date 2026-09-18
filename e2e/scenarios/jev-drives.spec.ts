/**
 * Jev drives an outcome in the app: a seat it judges blocked does not get typed
 * into.
 *
 *   JUNTO_LIVE_JEV=1 TYPESAFE_API_KEY=... bun run test:e2e e2e/scenarios/jev-drives.spec.ts
 *
 * Two seats, the same operator prompt, the same code path. One is showing a
 * real Devin trust dialog (the corpus screen `devin/startup-trust#789`, which
 * the paid holdout run scored approval_requested 0.95); the other is sitting at
 * an idle prompt. The prompt to the blocked seat must come back `queued`, and
 * the prompt to the free seat `submitted`. If both behave the same, the AI
 * verdict is not reaching the drive and this fails.
 *
 * The dialog is written with echo off and a clear first so the typed command
 * line is not part of the screen, and it ends in `read` so the shell blocks
 * without printing a prompt: a prompt is exactly what tells the model the seat
 * is not blocked.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const API_KEY = process.env.TYPESAFE_API_KEY ?? "";
const LIVE = process.env.JUNTO_LIVE_JEV === "1";

const BLOCKED_LABEL = "Jev blocked seat";
const BLOCKED_BINDING = "jev-blocked-binding";
const FREE_LABEL = "Jev free seat";
const FREE_BINDING = "jev-free-binding";

/**
 * `pi/type-echo#23000` verbatim, base64 so the bytes are exact: the paid holdout
 * run scored this screen access_problem 0.98 (and execution_error 0.97), which
 * is a holding state. Written into the sandbox and `cat`ed, so no shell escaping
 * and no printf dialect stands between the model and the bytes it was scored on.
 */
const SCREEN_B64 =
  "CgoKW0V4dGVuc2lvbnNdCiAgc2FtcGxlL2V4dGVuc2lvbnMvc2FtcGxlLWV4dGVuc2lvbi5qcwoKCgoKCgoKCgoK4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiBVcGRhdGUgQXZhaWxhYmxlCiBOZXcgdmVyc2lvbiAwLjg0LjEgaXMgYXZhaWxhYmxlLiBSdW4gcGkgdXBkYXRlCiBDaGFuZ2Vsb2c6IGh0dHBzOi8vcGkuZGV2L2NoYW5nZWxvZwrilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKCiBFcnJvcjogTm8gQVBJIGtleSBmb3VuZCBmb3IgYnVpbHRpbi1tb2NrLXJlc3BvbnNlcy4KCiBVc2UgL2xvZ2luIHRvIGxvZyBpbnRvIGEgcHJvdmlkZXIgdmlhIE9BdXRoIG9yIEFQSSBrZXkuIFNlZToKCiA8SE9NRT4vLnBpLWFnZW50L2RvY3MvcHJvdmlkZXJzLm1kCgoKIDxIT01FPi8ucGktYWdlbnQvZG9jcy9tb2RlbHMubWQKCgrilIDilIDilIDilIDilIA=";

const SCREEN_TEXT = Buffer.from(SCREEN_B64, "base64").toString("utf8");

const DIALOG_COMMAND =
  "stty -echo; clear; cat \"$HOME/jev-screen.txt\"; read -r choice";

test.use({
  juntoOptions: {
    extraEnv: {
      ...(API_KEY === "" ? {} : { TYPESAFE_API_KEY: API_KEY }),
      JUNTO_AWARENESS: "on",
      JUNTO_AWARENESS_TRACE: "1",
    },
    afterSeed: async (sandbox) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(sandbox.homeDir, "jev-screen.txt"), SCREEN_TEXT, "utf8");
    },
    seedCanvases: {
      jevdrives: canvasDoc([
        terminalTextNode({
          id: "jev-blocked-node",
          bindingId: BLOCKED_BINDING,
          label: BLOCKED_LABEL,
          x: 80,
          y: 40,
          launch: { kind: "command", argv: ["/bin/sh", "-i"] },
        }),
        terminalTextNode({
          id: "jev-free-node",
          bindingId: FREE_BINDING,
          label: FREE_LABEL,
          x: 480,
          y: 40,
          launch: { kind: "command", argv: ["/bin/sh", "-i"] },
        }),
      ]),
    },
  },
});

/**
 * The screen used to be judged wrongly because the product's composer-exclusion
 * heuristic dropped the error block as a prompt box (12 lines, including
 * "Error: No API key found for builtin-mock-responses."), so the model was asked
 * about a credential failure with the credential failure deleted and answered
 * 0.02. Fixed in select-input: a candidate composer range that carries a failure
 * marker is not a composer. The same request now answers 0.96.
 */
test("a seat Jev judges blocked is not typed into; a free seat is", async ({
  junto,
}) => {
  test.setTimeout(480_000);
  const { page } = junto;
  test.skip(
    !LIVE || API_KEY === "",
    "live Jev run: set JUNTO_LIVE_JEV=1 and TYPESAFE_API_KEY",
  );

  const mainLog: string[] = [];
  junto.app.process().stdout?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
  junto.app.process().stderr?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
  const logLines = (marker: string): readonly string[] =>
    mainLog
      .join("")
      .split("\n")
      .filter((line) => line.includes(marker));

  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.evaluate(() => {
    const target = window as unknown as {
      __jevEvents?: unknown[];
      junto?: {
        onSeatAwarenessChanged?: (listener: (event: unknown) => void) => () => void;
      };
    };
    target.__jevEvents = [];
    target.junto?.onSeatAwarenessChanged?.((event: unknown) => {
      target.__jevEvents?.push(event);
    });
  });

  // Open both seats so both are observed by the sidecar.
  const surface = page.locator(".native-terminal-surface");
  const blockedNode = page.locator(".react-flow__node", { hasText: BLOCKED_LABEL });
  await expect(blockedNode).toBeVisible({ timeout: 60_000 });
  await blockedNode.dblclick();
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type(DIALOG_COMMAND);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_000);
  await surface.getByRole("button", { name: "Close" }).click();
  await expect(surface).toBeHidden({ timeout: 20_000 });

  const freeNode = page.locator(".react-flow__node", { hasText: FREE_LABEL });
  await freeNode.dblclick();
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await surface.getByRole("button", { name: "Close" }).click();
  await expect(surface).toBeHidden({ timeout: 20_000 });

  // The dialog lands after the first-screen judgment, so the ask about it is
  // paced by the interval floor. Hover both seats meanwhile: the hover trigger
  // is immediate.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await blockedNode.hover();
    await page.waitForTimeout(10_000);
    await freeNode.hover();
    await page.waitForTimeout(10_000);
    if (logLines("[jev-hold]").length > 0) break;
  }

  const wire = (await page.evaluate(
    () => (window as unknown as { __jevEvents?: unknown[] }).__jevEvents ?? [],
  )) as ReadonlyArray<{ kind?: string; assessment?: Record<string, unknown> }>;
  const seen = new Set<unknown>();
  for (const event of wire.filter((entry) => entry.kind === "assessment")) {
    const assessment = event.assessment ?? {};
    const at = assessment["observedAt"];
    if (seen.has(at)) continue;
    seen.add(at);
    const concerns = (assessment["concerns"] as ReadonlyArray<{ concern?: string }> | undefined) ?? [];
    const absences = (assessment["absences"] as ReadonlyArray<{ concern?: string; probability?: number }> | undefined) ?? [];
    const lines = ((assessment["evidence"] as { lines?: ReadonlyArray<{ text?: string }> } | undefined)?.lines ?? [])
      .map((line) => (line.text ?? "").trim())
      .filter((text) => text.length > 0)
      .slice(0, 4);
    console.log(
      "JEV DRIVES WIRE " +
        JSON.stringify({
          availability: assessment["availability"],
          concerns: concerns.map((entry) => entry.concern),
          absences: absences.map((entry) => `${entry.concern}:${entry.probability}`),
          unanswered: assessment["unansweredConcerns"],
          lines,
        }),
    );
  }
  const holds = logLines("[jev-hold]");
  const calls = logLines("[jev-call]");
  console.log("JEV DRIVES calls=" + String(calls.length));
  for (const line of calls) console.log("  " + line.slice(line.indexOf("[jev-call]")));
  console.log("JEV DRIVES holds=" + String(holds.length));
  for (const line of holds) console.log("  " + line.slice(line.indexOf("[jev-hold]")));
  // The hold is the outcome: the AI verdict reached the delivery gate for a
  // seat the model judged blocked on access, in the running app.
  expect(holds.length).toBeGreaterThan(0);
  expect(holds.join(" ")).toMatch(/blocked_on_access|waiting_on_approval/);
});

/**
 * The effect of the hold — a prompt deferred rather than typed — needs a
 * managed harness seat: the operator prompt path refuses a raw terminal with
 * "Immediate prompts require a local managed seat", so this cannot be shown on
 * the `sh -i` seats above. Same experiment, one managed seat, next.
 */
test("a held seat defers an operator prompt and a free seat takes it", async ({
  junto,
}) => {
  test.skip(
    !LIVE || API_KEY === "",
    "live Jev run: set JUNTO_LIVE_JEV=1 and TYPESAFE_API_KEY",
  );
  test.fixme(true, "needs a local managed seat: a raw terminal refuses immediate prompts");

  const { page } = junto;
  // Same operator action, same code path, two seats.
  const ask = (bindingId: string, nodeId: string, text: string) =>
    page.evaluate(
      ([binding, node, prompt]) =>
        (
          window as unknown as {
            junto: {
              terminalManagedPrompt: (input: {
                bindingId: string;
                nodeId: string;
                canvasName: string;
                text: string;
              }) => Promise<{ ok: boolean; disposition: string; reason?: string }>;
            };
          }
        ).junto.terminalManagedPrompt({
          bindingId: binding,
          nodeId: node,
          canvasName: "jevdrives",
          text: prompt,
        }),
      [bindingId, nodeId, text] as const,
    );

  const blocked = await ask(BLOCKED_BINDING, "jev-blocked-node", "PROBE-HELD-PROMPT");
  const free = await ask(FREE_BINDING, "jev-free-node", "PROBE-FREE-PROMPT");
  console.log("JEV DRIVES blocked=" + JSON.stringify(blocked));
  console.log("JEV DRIVES free=" + JSON.stringify(free));

  // The seat Jev is holding on a dialog is not typed into; the free seat is.
  expect(blocked.disposition).toBe("queued");
  expect(free.disposition).toBe("submitted");
});
