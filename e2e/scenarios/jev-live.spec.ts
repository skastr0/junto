/**
 * Jev, live, in the running app — a real judgment on a real screen.
 *
 *   JUNTO_LIVE_JEV=1 TYPESAFE_API_KEY=... bun run test:e2e e2e/scenarios/jev-live.spec.ts
 *
 * Opt-in on purpose: this spec spends money on a real provider, so it must not
 * run as part of a regression sweep that happens to have a key in the
 * environment.
 *
 * Everything else in this repository's awareness tests runs with the model
 * either absent or constructed from fakes. This spec opens a real PTY, puts a
 * real screen in front of it, and waits for the real sidecar to publish a real
 * judgment that the hover then paints. It costs a few cents and it is the only
 * test that can answer "does the product do this".
 *
 * The key comes from the environment; it is never written into the spec, the
 * sandbox, or a log.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";


const API_KEY = process.env.TYPESAFE_API_KEY ?? "";
const LIVE = process.env.JUNTO_LIVE_JEV === "1";
const LABEL = "Jev live seat";
const BINDING = "jev-live-binding";
/**
 * A seat that is really blocked: the shell prints an approval menu and then
 * waits on input, so the process is genuinely stopped at a dialog rather than
 * showing text that happens to look like one.
 */
const SCREEN =
  "printf '\\nJEV-LIVE-PROBE\\nDo you want to allow this action?\\n" +
  "  1. Yes, allow once\\n  2. No, and tell the agent what to do differently\\n'; " +
  "read -r choice";

test.use({
  juntoOptions: {
    extraEnv: {
      ...(API_KEY === "" ? {} : { TYPESAFE_API_KEY: API_KEY }),
      JUNTO_AWARENESS: "on",
      // The provider call trace: this spec counts real calls, so it asks main
      // to say when one happened.
      JUNTO_AWARENESS_TRACE: "1",
    },
    seedCanvases: {
      jevlive: canvasDoc([
        terminalTextNode({
          id: "jev-live-node",
          bindingId: BINDING,
          label: LABEL,
          x: 80,
          y: 40,
          launch: { kind: "command", argv: ["/bin/sh", "-i"] },
        }),
      ]),
    },
  },
});

test("a real screen produces a real Jev judgment that the card paints", async ({
  junto,
}) => {
  test.setTimeout(420_000);
  const { page } = junto;
  // The provider call log from main: an exact count of real Jev calls, not an
  // inference from the UI.
  const callLog: string[] = [];
  junto.app.process().stdout?.on("data", (chunk: Buffer) => callLog.push(String(chunk)));
  junto.app.process().stderr?.on("data", (chunk: Buffer) => callLog.push(String(chunk)));
  test.skip(
    !LIVE || API_KEY === "",
    "live Jev run: set JUNTO_LIVE_JEV=1 and TYPESAFE_API_KEY",
  );

  await page.setViewportSize({ width: 1440, height: 1200 });
  // Capture the producer's own events: the assessment the sidecar published,
  // with the per-concern probabilities, not the UI's summary of it.
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
  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 60_000 });
  await node.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });

  // A real PTY with a real screen: the observer has bytes to project.
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type(SCREEN);
  await page.keyboard.press("Enter");
  // The surface is a real PTY painting a real screen (captured in the failure
  // screenshot when this runs). The first-screen judgment is about the bare
  // prompt; the reactive pass on this material revision is paced by
  // `workingTextIntervalMs` (60s), so the wait has to clear that floor.
  await page.waitForTimeout(80_000);

  // Back to the card: the seat keeps running, the surface is only a view.
  await surface.getByRole("button", { name: "Close" }).click();
  await expect(surface).toBeHidden({ timeout: 20_000 });

  // The sidecar coalesces, spends one call on the first screen, and publishes.
  await node.hover();
  const hover = node.locator("[data-seat-awareness]");
  await expect(hover).toBeVisible({ timeout: 20_000 });
  await expect(hover).toHaveAttribute("data-seat-awareness", "current", {
    timeout: 240_000,
  });

  const events = (await page.evaluate(
    () => (window as unknown as { __jevEvents?: unknown[] }).__jevEvents ?? [],
  )) as ReadonlyArray<{
    readonly kind?: string;
    readonly assessment?: Record<string, unknown>;
  }>;
  const assessments = events.filter((event) => event.kind === "assessment");
  // One line per distinct judgment: the same advisory is republished on every
  // window event and every renderer hydration.
  const seenObservedAt = new Set<unknown>();
  console.log(
    "JEV LIVE WIRE " +
      JSON.stringify(
        assessments
          .filter((event) => {
            const at = event.assessment?.["observedAt"];
            if (seenObservedAt.has(at)) return false;
            seenObservedAt.add(at);
            return true;
          })
          .map((event) => ({
          availability: event.assessment?.["availability"],
          activity: event.assessment?.["activity"],
          concerns: event.assessment?.["concerns"],
          absences: event.assessment?.["absences"],
          unanswered: event.assessment?.["unansweredConcerns"],
          observedAt: event.assessment?.["observedAt"],
          lines: (
            (event.assessment?.["evidence"] as
              | { lines?: ReadonlyArray<{ text?: string }> }
              | undefined)?.lines ?? []
          )
            .map((line) => (line.text ?? "").trim())
            .filter((text) => text.length > 0)
            .slice(0, 6),
        })),
      ).slice(0, 2600),
  );
  const readout = await hover.evaluate((el) => ({
    availability: el.getAttribute("data-seat-awareness"),
    control: el.getAttribute("data-awareness-control-state"),
    aiLabel: el.getAttribute("data-awareness-ai-label"),
    judgment: el.getAttribute("data-awareness-judgment"),
    cleared: el.getAttribute("data-awareness-cleared"),
    chips: Array.from(el.querySelectorAll("span"))
      .map((chip) => (chip.textContent ?? "").trim())
      .filter((text) => text.length > 0 && text.length < 60),
    text: (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 400),
  }));
  console.log("JEV LIVE JUDGMENT " + JSON.stringify(readout));
  await page.screenshot({
    path: ".amp/in/artifacts/jev-live-judgment.png",
  });

  // A real judgment about a real screen: the sidecar looked and answered.
  expect(readout.judgment).toBe("current");
  expect(readout.aiLabel ?? "").not.toBe("");
  const providerCalls = callLog
    .join("")
    .split("\n")
    .filter((line) => line.includes("[jev-call]"));
  console.log("JEV LIVE CALLS " + String(providerCalls.length));
  for (const line of providerCalls) console.log("  " + line.slice(line.indexOf("[jev-call]")));
  console.log(
    "JEV LIVE CHIPS " + JSON.stringify(readout.chips.filter((chip) => chip !== readout.aiLabel)),
  );
  expect(providerCalls.length).toBeGreaterThanOrEqual(2);
});
