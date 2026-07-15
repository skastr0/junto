import { describe, expect, it } from "vitest";
import type { DraftItem } from "@skastr0/booth-sdk";

import { fetchBoothReview, mapBoothDraftRows } from "../src/main/vellum/adapters/booth-controls";

// The SDK decodes rows before they reach the adapter, so fixtures are shaped as
// already-decoded DraftItems (mediaKind/status/updatedAt typed), cast to the
// SDK type for the fields the mapper actually reads.
const draftItem = (over: Partial<DraftItem>): DraftItem =>
  ({
    draftItemId: "draft_abc123",
    projectKey: "vellum",
    title: "Launch teaser v2",
    mediaKind: "video",
    assetType: "creative",
    status: "ready_for_review",
    createdAt: 1783000000000,
    updatedAt: 1783000500000,
    ...over,
  }) as unknown as DraftItem;

describe("mapBoothDraftRows", () => {
  it("projects decoded DraftItems onto the BoothDraftRow IPC contract", () => {
    const rows = [
      draftItem({ draftItemId: "draft_abc123", title: "Launch teaser v2", status: "ready_for_review", mediaKind: "video", updatedAt: 1783000500000 }),
      draftItem({ draftItemId: "draft_def456", title: "Hero still", status: "approved", mediaKind: "image", updatedAt: 1783100000000 }),
    ];
    expect(mapBoothDraftRows(rows)).toEqual([
      { id: "draft_abc123", title: "Launch teaser v2", status: "ready_for_review", kind: "video", updatedAt: new Date(1783000500000).toISOString() },
      { id: "draft_def456", title: "Hero still", status: "approved", kind: "image", updatedAt: new Date(1783100000000).toISOString() },
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(mapBoothDraftRows([])).toEqual([]);
  });
});

// The blank-body guard short-circuits before any SDK/network call, so these run
// hermetically (no live server, no SdkRuntime resolution). The success path is
// covered by the SDK's own error-contract tests and the live probe.
describe("fetchBoothReview body guard", () => {
  it("rejects a blank comment body without a roundtrip", async () => {
    const result = await fetchBoothReview("vellum", "draft_1", "comment", "   ");
    expect(result).toEqual({ ok: false, error: "comment requires a non-empty body" });
  });

  it("rejects a missing request_revision body without a roundtrip", async () => {
    const result = await fetchBoothReview("vellum", "draft_1", "request_revision");
    expect(result).toEqual({ ok: false, error: "request_revision requires a non-empty body" });
  });
});
