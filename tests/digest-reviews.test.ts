import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import type { SnapshotState } from "../src/shared/entities";
import type { ReviewVerdict } from "../src/shared/crew";
import {
  digestCanvas as digestCanvasWithActorRefs,
  type DigestLiveViews,
} from "../src/shared/digest";
import {
  actorRefFixture,
  executionContextForDoc,
} from "./helpers/actor-ref-fixtures";

// Reviews digest section: durable projection of the verdict chain a task
// carries and the requires-review arming from board/task rules. Projection,
// never judgment — entries are marked against the task's CURRENT projected
// binding (epoch + subject hash), ordered deterministically, no timestamps.

const digestCanvas = (
  name: string,
  doc: CanvasDoc,
  snapshots: SnapshotState = { bundles: [] },
  live: Omit<DigestLiveViews, "resolveActorRef"> = {},
): string =>
  digestCanvasWithActorRefs(name, doc, snapshots, {
    ...live,
    resolveActorRef: executionContextForDoc(doc, name).resolveActorRef,
  });

const AUTHOR = actorRefFixture("author", "fixture").seatId;
const REVIEWER = actorRefFixture("reviewer", "fixture").seatId;
const HASH_CURRENT = "a".repeat(64);
const HASH_OLD = "b".repeat(64);

const verdict = (input: {
  readonly kind: "green" | "blocking";
  readonly epoch: number;
  readonly subjectHash: string;
  readonly postedAtMs: number;
  readonly verdictId: string;
  readonly findings?: ReadonlyArray<string>;
}): ReviewVerdict => ({
  verdictId: input.verdictId,
  kind: input.kind,
  reviewerSeatId: REVIEWER,
  reviewerNodeId: "reviewer",
  authorSeatId: AUTHOR,
  subject: {
    kind: "task",
    installationId: Schema.decodeUnknownSync(InstallationId)("inst-1"),
    canvasName: "fixture",
    nodeId: "b1",
    taskId: "t-1",
    epoch: input.epoch,
    subjectHash: input.subjectHash,
  },
  subjectHash: input.subjectHash,
  epoch: input.epoch,
  findings: [...(input.findings ?? [])],
  refs: [],
  postedAtMs: input.postedAtMs,
});

const boardWith = (item: Record<string, unknown>): CanvasDoc => ({
  nodes: [
    {
      id: "b1",
      type: "text",
      text: "board",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: {
        entity: { kind: "task" },
        tasks: {
          contract: {
            rules: [
              { id: "rv", text: "independent review", kind: "requires-review" },
            ],
          },
          items: [
            {
              id: "t-1",
              state: "working",
              claimedBy: AUTHOR,
              epoch: 2,
              history: [
                {
                  messageId: "m1",
                  role: "user",
                  parts: [{ kind: "text", text: "paint fence" }],
                  taskId: "t-1",
                },
              ],
              ...item,
            },
          ],
        },
      },
    } as CanvasDoc["nodes"][number],
  ],
  edges: [],
});

describe("reviews digest section", () => {
  it("omitted entirely without armed rules or verdicts", () => {
    const doc = boardWith({});
    // Strip the requires-review rule: nothing to project.
    const bare: CanvasDoc = {
      nodes: [
        {
          ...doc.nodes[0]!,
          ether: {
            entity: { kind: "task" },
            tasks: { items: doc.nodes[0]!.ether!.tasks!.items },
          },
        } as CanvasDoc["nodes"][number],
      ],
      edges: [],
    };
    expect(digestCanvas("fixture", bare)).not.toContain("reviews");
  });

  it("an armed requires-review rule projects even before any verdict", () => {
    const out = digestCanvas("fixture", boardWith({}));
    expect(out).toContain("reviews");
    expect(out).toContain("paint fence :: epoch 2 :: subject - :: author ");
    expect(out).toContain("review required");
  });

  it("renders the chain ordered, marked against the current binding", () => {
    const out = digestCanvas(
      "fixture",
      boardWith({
        subjectHash: HASH_CURRENT,
        verdicts: [
          // Supplied out of order; the digest must sort by postedAtMs.
          verdict({
            kind: "blocking",
            epoch: 2,
            subjectHash: HASH_CURRENT,
            postedAtMs: 20,
            verdictId: "v-2",
            findings: ["wrong fence"],
          }),
          verdict({
            kind: "green",
            epoch: 2,
            subjectHash: HASH_CURRENT,
            postedAtMs: 10,
            verdictId: "v-1",
          }),
          verdict({
            kind: "green",
            epoch: 1,
            subjectHash: HASH_OLD,
            postedAtMs: 30,
            verdictId: "v-3",
          }),
        ],
      }),
    );
    const lines = out.split("\n");
    const entries = lines.filter((line) => /^  #\d/.test(line));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain(`#1 green`);
    expect(entries[0]).toContain(`subject ${HASH_CURRENT.slice(0, 12)} (current)`);
    expect(entries[1]).toContain(`#2 blocking`);
    expect(entries[1]).toContain("wrong fence");
    expect(entries[1]).toContain("(current)");
    expect(entries[2]).toContain(`#3 green`);
    expect(entries[2]).toContain("(old epoch)");

    // Header pins the projected current binding.
    expect(out).toContain(`subject ${HASH_CURRENT.slice(0, 12)}`);
  });

  it("marks same-epoch verdicts on other refs as stale refs", () => {
    const out = digestCanvas(
      "fixture",
      boardWith({
        subjectHash: HASH_CURRENT,
        verdicts: [
          verdict({
            kind: "green",
            epoch: 2,
            subjectHash: HASH_OLD,
            postedAtMs: 5,
            verdictId: "v-1",
          }),
        ],
      }),
    );
    expect(out).toContain(`(stale refs)`);
  });

  it("is byte-identical across repeated projections of the same doc", () => {
    const doc = boardWith({
      subjectHash: HASH_CURRENT,
      verdicts: [
        verdict({
          kind: "green",
          epoch: 2,
          subjectHash: HASH_CURRENT,
          postedAtMs: 1,
          verdictId: "v-1",
        }),
      ],
    });
    expect(digestCanvas("fixture", doc)).toBe(digestCanvas("fixture", doc));
  });

  it("drops undecodable verdict entries instead of failing the projection", () => {
    const out = digestCanvas(
      "fixture",
      boardWith({
        verdicts: [{ not: "a verdict" }],
      }),
    );
    expect(out).toContain("reviews");
    expect(out).not.toContain("#1");
  });
});
