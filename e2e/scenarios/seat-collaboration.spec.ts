/**
 * Seat collaboration — one seat asks a peer for help, in the running product.
 *
 *   bun run test:e2e e2e/scenarios/seat-collaboration.spec.ts
 *
 * What this proves that a unit test cannot: the hover surface renders on a real
 * card in the real app, the click travels renderer -> IPC -> WorkService -> the
 * peer's mailbox, and the returned document turns the suggestion into an open
 * thread on the card.
 *
 * The mailbox assertions read the durable table the delivery pipeline reads,
 * not the copy on screen, so a request that never landed fails here rather than
 * looking right in the UI.
 *
 * The seats are seeded cold: no harness spawns, so their control state is
 * unknown. That is a real state for this feature — crew mail queues and wakes a
 * cold seat, which is why an unknown peer is askable and is described honestly
 * as "connected, no live turn".
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const BUILDER = "e2e-collab-builder";
const IRIS = "e2e-collab-iris";

test.use({
  juntoOptions: {
    seedCanvases: {
      collab: canvasDoc([
        agentTextNode({
          id: BUILDER,
          key: "e2e-collab-builder-binding",
          label: "Builder",
          x: 80,
          y: 40,
        }),
        agentTextNode({
          id: IRIS,
          key: "e2e-collab-iris-binding",
          label: "Iris",
          x: 460,
          y: 40,
        }),
        // A third seat further down the canvas: the fit-to-view centring then
        // leaves the two top cards high enough for the overlay to be captured
        // whole, and the ranking has more than one peer to order.
        agentTextNode({
          id: "e2e-collab-muse",
          key: "e2e-collab-muse-binding",
          label: "Muse",
          x: 80,
          y: 560,
        }),
      ]),
    },
  },
});

type MailRow = {
  readonly message_id: string;
  readonly parts_json: string;
  readonly metadata_json: string | null;
};

/** Mail durably queued on one seat, read from the delivery table. */
const mailboxOf = (appHome: string, nodeId: string): readonly MailRow[] => {
  const db = new DatabaseSync(join(appHome, ".junto", "state", "junto.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT message_id, parts_json, metadata_json FROM work_messages " +
          "WHERE node_id = ? ORDER BY position",
      )
      .all(nodeId) as unknown as readonly MailRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
};

const textOf = (row: MailRow): string =>
  (JSON.parse(row.parts_json) as ReadonlyArray<{ readonly text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n");

const metadataOf = (row: MailRow): Record<string, unknown> =>
  row.metadata_json === null
    ? {}
    : (JSON.parse(row.metadata_json) as Record<string, unknown>);

test("a seat asks a peer for help and the request lands in the peer mailbox", async ({
  junto,
}) => {
  test.setTimeout(240_000);
  const { page, sandbox } = junto;
  // A taller window than the harness default: the seat overlay stacks the
  // awareness hover above the collaboration panel, both hanging below the card,
  // and the capture should show all of it without the station bar covering the
  // action.
  await page.setViewportSize({ width: 1440, height: 1400 });
  const builder = page.locator(".react-flow__node", { hasText: "Builder" });
  await expect(builder).toBeVisible({ timeout: 60_000 });

  // Hover reveals the collaboration surface under the awareness card.
  await builder.hover();
  const block = builder.locator("[data-seat-collaboration]");
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText("Iris can help");
  const ask = block.getByRole("button", { name: /Ask Iris/ });
  await expect(ask).toBeVisible();
  await expect(ask).toBeEnabled();
  await page.screenshot({
    path: ".amp/in/artifacts/seat-collaboration-suggestion.png",
  });

  // A suggestion is not a request: nothing has been sent yet.
  expect(mailboxOf(sandbox.homeDir, IRIS)).toHaveLength(0);

  await ask.click();

  // The click turns the suggestion into an open thread on the card.
  await expect(builder.locator('[data-collaboration-thread="asked"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(block).toContainText("waiting for a reply");
  // The seat that was asked is not offered again while it has not answered.
  await expect(block.getByRole("button", { name: /Ask Iris/ })).toHaveCount(0);
  await page.screenshot({
    path: ".amp/in/artifacts/seat-collaboration-asked.png",
  });

  // The mailbox is the source of truth.
  const mailbox = mailboxOf(sandbox.homeDir, IRIS);
  expect(mailbox).toHaveLength(1);
  const request = mailbox[0]!;
  const text = textOf(request);
  const metadata = metadataOf(request);
  expect(text).toContain("[collaboration request from Builder]");
  expect(text).toContain("junto msg reply");
  expect(metadata.juntoCollaborationSourceNodeId).toBe(BUILDER);
  expect(metadata.factoryMail).toBe(true);
  const requestId = String(metadata.juntoCollaborationRequestId ?? "");
  expect(requestId).toBe(request.message_id);
  expect(text).toContain(`"inReplyTo":"${requestId}"`);

  // The asking seat's own mailbox is untouched: the request is outbound.
  expect(mailboxOf(sandbox.homeDir, BUILDER)).toHaveLength(0);

  console.log(
    `COLLABORATION PROOF: requestId=${requestId} target=Iris mailbox=${String(mailbox.length)}`,
  );
});
