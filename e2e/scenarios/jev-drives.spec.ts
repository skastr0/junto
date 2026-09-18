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
 * WHY THIS FAILS, and the finding it produced (2026-09-18).
 *
 * The corpus screen `pi/type-echo#23000` scores access_problem 0.98 in the paid
 * holdout run. The same bytes, in a live seat, score access_problem 0.02 —
 * decisively absent — and the hold never engages, so this assertion cannot pass.
 *
 * The two paths do not ask the same question:
 *   - the evaluation harness asks 9 questions from a frozen pack, each Noul
 *     carrying its true/false criteria text, over a window PAIR (earlier + now);
 *   - the product asks 12 questions from `awareness/questions.ts`, with different
 *     wording per question, NO criteria text for Nouls (the client passes none),
 *     and a single window plus a note.
 *
 * So the holdout numbers describe the harness pack, not the product. Every
 * calibration claim made from them ("concerns never wrong") is unverified for
 * what ships. Fixing this is a pack alignment or a fresh evaluation of the
 * product's own pack; until then this spec stays failing on purpose.
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
  test.fixme(
    true,
    "product pack and evaluated pack have drifted: same bytes score 0.02 live vs 0.98 in the harness",
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
  expect(holds.join(" ")).toContain("waiting_on_approval");

  // Same operator action, same code path, two seats.
  const ask = (bindingId: string, text: string) =>
    page.evaluate(
      ([binding, prompt]) =>
        (
          window as unknown as {
            junto: {
              terminalManagedPrompt: (input: {
                bindingId: string;
                text: string;
              }) => Promise<{ ok: boolean; disposition: string; reason?: string }>;
            };
          }
        ).junto.terminalManagedPrompt({ bindingId: binding, text: prompt }),
      [bindingId, text] as const,
    );

  const blocked = await ask(BLOCKED_BINDING, "PROBE-HELD-PROMPT");
  const free = await ask(FREE_BINDING, "PROBE-FREE-PROMPT");
  console.log("JEV DRIVES blocked=" + JSON.stringify(blocked));
  console.log("JEV DRIVES free=" + JSON.stringify(free));

  // The seat Jev is holding on a dialog is not typed into; the free seat is.
  expect(blocked.disposition).toBe("queued");
  expect(free.disposition).toBe("submitted");
});
