/**
 * Requests node regression spec — authored sink identity, attention-first
 * glance, honest inbox accounting, answerable-only response UI.
 *   bun run test:e2e:fast e2e/scenarios/requests-audit.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Task } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  flipFixtureRequestState,
  requestsNode,
  taskItem,
  verbEdge,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "requests-audit");
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const LONG_TITLE =
  "Confirm the release signing identity for the staging fleet before the artifact is distributed to remote stations";

const requestWith = (
  id: string,
  brief: string,
  state: Task["state"],
  extra?: Partial<Task>,
): Task => ({
  ...taskItem(id, brief, state),
  ...extra,
  history: [...(extra?.history ?? taskItem(id, brief, state).history)],
});

const SINK_NAME = "Vendor keys";

const items: Task[] = [
  requestWith("r-a", LONG_TITLE, "input-required", {
    metadata: { title: LONG_TITLE, details: "The distribution step is paused until the operator confirms the identity." },
  }),
  requestWith("r-b", "Grant remote station access", "input-required", {
    metadata: { title: "Grant remote station access", details: "Station remote-a asks for peer admission to the fleet projection." },
  }),
  requestWith("r-c", "Pick the deploy window for tonight", "input-required"),
  requestWith("r-d", "Confirm service key rotation", "completed", {
    metadata: { title: "Confirm service key rotation", details: "Rotated 2026-09-01." },
    response: "Use the staged identity.",
  }),
  requestWith("r-e", "Approve unsafe host cleanup", "rejected", {
    metadata: { title: "Approve unsafe host cleanup", details: "The proposed operation exceeded scope." },
  }),
  requestWith("r-f", "Choose the migration lane", "completed"),
  // Residual durable-only state: waits on the operator, cannot be answered.
  requestWith("r-g", "Legacy authorization wait", "auth-required", {
    metadata: { title: "Legacy authorization wait", details: "Row predates the request producer." },
  }),
];

const nodes = [
  // Stale pre-identity mirror text on purpose: every title must read the
  // authored name, never node.text's first line.
  { ...requestsNode({ id: "req1", x: 300, y: 300, name: SINK_NAME, items }), text: "3 pending" },
  requestsNode({ id: "reqEmpty", x: 620, y: 300 }),
  agentTextNode({ id: "agent1", key: "local:planner", label: "planner", x: 300, y: 60 }),
];

const doc = canvasDoc(nodes, [
  verbEdge("e-esc", "agent1", "req1", "escalates", nodes),
]);

test.use({
  juntoOptions: {
    seedCanvases: { probe: doc },
    // Residual auth-required has no producer: create it the way old databases
    // carry it — a durable row state older than the current state machine.
    afterSeed: (sandbox) =>
      Promise.resolve(
        flipFixtureRequestState(
          sandbox,
          { canvasName: "probe", nodeId: "req1", requestId: "r-g" },
          "auth-required",
        ),
      ),
    extraEnv: {
      JUNTO_E2E_RENDERER_SURFACE_TIMEOUT_MS: "5000",
    },
  },
});

test("requests: authored identity, attention-first glance, honest inbox", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  const req1 = page.locator('.react-flow__node[data-id="req1"]');
  const reqEmpty = page.locator('.react-flow__node[data-id="reqEmpty"]');
  await expect(req1.getByTestId("requests-card")).toBeVisible();
  await expect(reqEmpty.getByTestId("requests-card")).toBeVisible();

  // --- Glance card: identity + attention-first ordering ------------------
  // Authored name wins over the stale "3 pending" mirror line.
  await expect(req1.getByTestId("requests-card")).toContainText(SINK_NAME);
  await expect(req1.getByTestId("requests-card")).not.toContainText("3 pending");
  // Attention count includes auth-required; pending rows lead the four slots.
  await expect(req1.getByTestId("requests-card")).toContainText("4 pending");
  const glanceStates = await req1.locator(".factory-glance__row").evaluateAll(
    (rows) => rows.map((row) => row.getAttribute("data-state")),
  );
  expect(glanceStates).toEqual([
    "auth-required",
    "input-required",
    "input-required",
    "input-required",
  ]);
  await shot(page, "01-glance-cards");

  // Empty sink: kind identity + quiet, never blank.
  await expect(reqEmpty.getByTestId("requests-card")).toContainText("quiet");

  // --- Inbox open --------------------------------------------------------
  await req1.getByTestId("requests-card").dispatchEvent("dblclick");
  const inbox = page.getByRole("dialog", { name: "Input requests" });
  await expect(inbox).toBeVisible();
  // Header carries the authored sink identity, not the mechanical dialog name.
  await expect(inbox.locator(".work-ledger-surface, [role='dialog']").first()).toContainText(SINK_NAME);

  // Honest sections: attention / resolved / other — auth-required is not
  // bucketed as resolved.
  const sectionNames = await inbox.locator("section > header h2").allInnerTexts();
  expect(sectionNames).toEqual(["Needs attention", "Resolved"]);
  const attentionSection = inbox.locator("section").filter({ hasText: "Needs attention" });
  const resolvedSection = inbox.locator("section").filter({ hasText: "Resolved" });
  await expect(attentionSection.locator("header span")).toHaveText("4");
  await expect(resolvedSection.locator("header span")).toHaveText("3");
  // Newest attention first, so the residual auth-required row leads.
  await expect(
    attentionSection.locator('[role="listitem"]').first(),
  ).toContainText("Legacy authorization wait");
  await expect(attentionSection).not.toContainText("Confirm service key rotation");
  await shot(page, "02-inbox-open");

  // --- Long titles: no read-more dead end --------------------------------
  await expect(inbox.getByRole("button", { name: "read more" })).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "less", exact: true })).toHaveCount(0);
  await expect(
    attentionSection.locator(".work-ledger-row__title").filter({ hasText: LONG_TITLE }),
  ).toHaveText(LONG_TITLE);
  const titleWhiteSpace = await attentionSection
    .locator(".work-ledger-row__title")
    .filter({ hasText: LONG_TITLE })
    .evaluate((el) => getComputedStyle(el).whiteSpace);
  expect(titleWhiteSpace).toBe("normal");

  // --- Rows are real buttons in listitems (no nested-button a11y crime) ---
  const rowButton = attentionSection.locator('[role="listitem"] button.work-ledger-row').first();
  await expect(rowButton).toBeVisible();

  // --- Search + empty copy -----------------------------------------------
  const search = inbox.getByRole("textbox", { name: "Search input requests" });
  await search.fill("rotate");
  await expect(resolvedSection).toContainText("Confirm service key rotation");
  await expect(attentionSection.locator('[role="listitem"]')).toHaveCount(0);
  await expect(attentionSection).toContainText("No matching requests");
  await shot(page, "03-search-filtered");
  await search.fill("zzz-no-match");
  await expect(inbox.locator(".work-ledger-list")).toContainText("No matching requests");
  await shot(page, "04-search-no-match");
  await search.fill("");

  // --- Residual auth-required: attention, explanation, no answer UI ------
  await attentionSection
    .locator('[role="listitem"]')
    .filter({ hasText: "Legacy authorization wait" })
    .getByRole("button")
    .click();
  const detail = inbox.locator(".work-ledger-detail");
  await expect(detail).toContainText("auth-required");
  await expect(detail).toContainText(
    "This request has an older authorization-wait state. It remains unresolved and cannot be answered here.",
  );
  await expect(detail.getByRole("textbox", { name: "Your response" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Send response" })).toHaveCount(0);
  await shot(page, "05-auth-required-explained");

  // --- Answerable request: named textarea, platform-true hint, resolve ----
  await attentionSection
    .locator('[role="listitem"]')
    .filter({ hasText: "Pick the deploy window" })
    .getByRole("button")
    .click();
  const response = detail.getByRole("textbox", { name: "Your response" });
  await expect(response).toBeVisible();
  const hint = await detail.locator(".work-ledger-detail__shortcut-hint").innerText();
  expect(hint).toContain("Ctrl");
  expect(hint).not.toContain("⌘");
  // Reject gating: disabled until text.
  await expect(detail.getByRole("button", { name: "Reject" })).toBeDisabled();
  await response.fill("Ship with the 20:00 window.");
  await shot(page, "06-response-typed");
  await detail.getByRole("button", { name: "Send response" }).click();
  // The harness backfills work_requests, so the resolve genuinely lands.
  await expect(
    resolvedSection.locator('[role="listitem"]').filter({ hasText: "Pick the deploy window" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    attentionSection.locator('[role="listitem"]').filter({ hasText: "Pick the deploy window" }),
  ).toHaveCount(0);
  await expect(attentionSection.locator("header span")).toHaveText("3");
  await expect(resolvedSection.locator("header span")).toHaveText("4");
  await shot(page, "07-after-resolve");
  await inbox.getByRole("button", { name: "Close input requests", exact: true }).click();
  await expect(inbox).toBeHidden();

  // --- Empty sink inbox: honest empty copy -------------------------------
  await reqEmpty.getByTestId("requests-card").dispatchEvent("dblclick");
  const emptyInbox = page.getByRole("dialog", { name: "Input requests" });
  await expect(emptyInbox).toBeVisible();
  await expect(emptyInbox.locator(".work-ledger-list")).toContainText(
    "Nothing needs you right now",
  );
  await expect(emptyInbox.locator(".work-ledger-list")).toContainText(
    "Nothing resolved yet",
  );
  await shot(page, "08-empty-inbox");
  await emptyInbox.getByRole("button", { name: "Close input requests", exact: true }).click();
  await expect(emptyInbox).toBeHidden();

  // --- Edge rail mirrors identity (escalates edge from agent1) ------------
  await req1.click();
  await shot(page, "09-final-canvas");
});
