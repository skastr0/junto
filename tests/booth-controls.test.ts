import { describe, expect, it } from "vitest";
import type { CreativeRequest, DraftDetail, DraftItem } from "@skastr0/booth-sdk";

import {
  absoluteBoothUrl,
  fetchBoothReview,
  mapBoothDraftDetail,
  mapBoothDraftRows,
  mapBoothRequestRows,
} from "../src/main/vellum/adapters/booth-controls";

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
      { id: "draft_abc123", title: "Launch teaser v2", status: "ready_for_review", kind: "video", assetType: "creative", updatedAt: new Date(1783000500000).toISOString() },
      { id: "draft_def456", title: "Hero still", status: "approved", kind: "image", assetType: "creative", updatedAt: new Date(1783100000000).toISOString() },
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(mapBoothDraftRows([])).toEqual([]);
  });
});

describe("absoluteBoothUrl", () => {
  it("resolves a root-relative media path against the api base's ORIGIN (path prefix dropped)", () => {
    expect(absoluteBoothUrl("https://booth-control.example.ts.net/booth-api", "/booth-media/assets/med_1"))
      .toBe("https://booth-control.example.ts.net/booth-media/assets/med_1");
  });

  it("works against the loopback default", () => {
    expect(absoluteBoothUrl("http://127.0.0.1:3213", "/booth-media/thumbnails/med_2"))
      .toBe("http://127.0.0.1:3213/booth-media/thumbnails/med_2");
  });

  it("degrades a missing path or malformed base to undefined", () => {
    expect(absoluteBoothUrl("https://x.example", undefined)).toBeUndefined();
    expect(absoluteBoothUrl("https://x.example", "")).toBeUndefined();
    expect(absoluteBoothUrl("not a url", "/assets/med_3")).toBeUndefined();
  });
});

describe("mapBoothDraftDetail", () => {
  const detail = (over: Partial<NonNullable<DraftDetail>>): NonNullable<DraftDetail> =>
    ({
      draft: draftItem({}),
      mediaAsset: null,
      reviewEvents: [],
      ...over,
    }) as unknown as NonNullable<DraftDetail>;

  it("projects draft + media + thread with absolute urls", () => {
    const mapped = mapBoothDraftDetail(
      detail({
        mediaAsset: {
          mediaAssetId: "med_1",
          projectKey: "vellum",
          mediaKind: "image",
          mimeType: "image/png",
          boothMediaUrl: "/booth-media/assets/med_1",
          boothThumbnailUrl: "/booth-media/thumbnails/med_1",
          createdAt: 1,
          updatedAt: 2,
        } as unknown as NonNullable<DraftDetail>["mediaAsset"],
        reviewEvents: [
          {
            reviewEventId: "rev_1",
            projectKey: "vellum",
            draftItemId: "draft_abc123",
            eventType: "request_revision",
            actor: "operator",
            body: "logo too small",
            createdAt: 1783000600000,
          } as unknown as NonNullable<DraftDetail>["reviewEvents"][number],
        ],
      }),
      "https://booth-control.example.ts.net/booth-api",
    );
    expect(mapped.mediaUrl).toBe("https://booth-control.example.ts.net/booth-media/assets/med_1");
    expect(mapped.thumbnailUrl).toBe("https://booth-control.example.ts.net/booth-media/thumbnails/med_1");
    expect(mapped.mimeType).toBe("image/png");
    expect(mapped.reviewEvents).toEqual([
      { id: "rev_1", eventType: "request_revision", actor: "operator", body: "logo too small", createdAt: 1783000600000 },
    ]);
  });

  it("omits media fields entirely when the draft carries no asset", () => {
    const mapped = mapBoothDraftDetail(detail({}), "http://127.0.0.1:3213");
    expect("mediaUrl" in mapped).toBe(false);
    expect("thumbnailUrl" in mapped).toBe(false);
    expect(mapped.id).toBe("draft_abc123");
    expect(mapped.status).toBe("ready_for_review");
  });
});

describe("mapBoothRequestRows", () => {
  it("projects decoded CreativeRequests onto the BoothRequestRow contract", () => {
    const request = {
      requestId: "req_1",
      projectKey: "vellum",
      title: "App icon refresh",
      requester: "beacon",
      assetType: "app-icon",
      targetPlacements: ["macos"],
      briefSummary: "New identity for the dock",
      status: "open",
      createdAt: 1,
      updatedAt: 1783200000000,
    } as unknown as CreativeRequest;
    expect(mapBoothRequestRows([request])).toEqual([
      {
        id: "req_1",
        title: "App icon refresh",
        status: "open",
        assetType: "app-icon",
        briefSummary: "New identity for the dock",
        requester: "beacon",
        updatedAt: 1783200000000,
      },
    ]);
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
