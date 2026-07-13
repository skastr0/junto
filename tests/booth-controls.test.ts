import { beforeEach, describe, expect, it, vi } from "vitest";

const runCliMock = vi.fn();

vi.mock("../src/main/vellum/adapters/exec", async () => {
  const actual = await vi.importActual<typeof import("../src/main/vellum/adapters/exec")>(
    "../src/main/vellum/adapters/exec",
  );
  return {
    ...actual,
    runCli: (...args: Parameters<typeof actual.runCli>) => runCliMock(...args),
  };
});

import {
  fetchBoothDrafts,
  fetchBoothReview,
  invokeBoothTool,
  mapBoothDraftRows,
} from "../src/main/vellum/adapters/booth-controls";

// Fixture captured live (2026-07-12) from `prism tools invoke booth
// drafts_list --input '{"project_key":"vellum"}'` against the currently-502ing
// Booth Control server (port-collision BC-201) — this is the exact shape the
// tool wire returns, not an invented one.
const boothCommandResult502 = {
  ok: false,
  command: "drafts list",
  error: {
    type: "BoothCliError",
    message: "502 Bad Gateway",
    details: { args: ["drafts", "list", "--project", "vellum", "--json"] },
  },
  stderr: "502 Bad Gateway\n",
  exit_code: 1,
};

const mcpEnvelope502 = {
  content: [{ type: "text", text: JSON.stringify(boothCommandResult502, null, 2) }],
  structuredContent: boothCommandResult502,
};

// Fixture captured live from an empty `--input '{}'` call against
// booth_drafts_list — the tool-input validation error shape.
const mcpEnvelopeValidationError = {
  content: [
    {
      type: "text",
      text: 'MCP error -32602: Input validation error: Invalid arguments for tool booth_drafts_list: [\n  {\n    "expected": "string",\n    "code": "invalid_type",\n    "path": [\n      "project_key"\n    ],\n    "message": "Invalid input: expected string, received undefined"\n  }\n]',
    },
  ],
  isError: true,
};

// Hypothetical success payload — the server is down (BC-201), so this shape
// is read straight off booth-control/convex/booth.ts's draftItems rows
// (draftItemId/title/status/mediaKind/createdAt/updatedAt), not guessed.
const draftRowsFixture = [
  {
    draftItemId: "draft_abc123",
    projectKey: "vellum",
    title: "Launch teaser v2",
    status: "ready_for_review",
    mediaKind: "video",
    channel: "instagram",
    createdAt: 1783000000000,
    updatedAt: 1783000500000,
  },
  {
    draftItemId: "draft_def456",
    projectKey: "vellum",
    title: "Hero still",
    status: "approved",
    mediaKind: "image",
    createdAt: 1783100000000,
    updatedAt: 1783100000000,
  },
];

const boothCommandResultSuccess = { ok: true, command: "drafts list", data: draftRowsFixture };
const mcpEnvelopeSuccess = {
  content: [{ type: "text", text: JSON.stringify(boothCommandResultSuccess) }],
  structuredContent: boothCommandResultSuccess,
};

beforeEach(() => {
  runCliMock.mockReset();
});

describe("mapBoothDraftRows", () => {
  it("maps the draftItems row shape (draftItemId/title/status/mediaKind/updatedAt)", () => {
    expect(mapBoothDraftRows(draftRowsFixture)).toEqual([
      { id: "draft_abc123", title: "Launch teaser v2", status: "ready_for_review", kind: "video", updatedAt: new Date(1783000500000).toISOString() },
      { id: "draft_def456", title: "Hero still", status: "approved", kind: "image", updatedAt: new Date(1783100000000).toISOString() },
    ]);
  });

  it("falls back to createdAt when updatedAt is absent", () => {
    const rows = [{ draftItemId: "d1", title: "t", createdAt: 1700000000000 }];
    expect(mapBoothDraftRows(rows)[0]?.updatedAt).toBe(new Date(1700000000000).toISOString());
  });

  it("drops rows missing id or title instead of emitting a partial row", () => {
    const rows = [{ draftItemId: "d1" }, { title: "no id" }, { draftItemId: "d2", title: "ok" }];
    expect(mapBoothDraftRows(rows)).toEqual([{ id: "d2", title: "ok", status: undefined, kind: undefined, updatedAt: undefined }]);
  });

  it("returns an empty array for non-object rows", () => {
    expect(mapBoothDraftRows([null, "x", 42])).toEqual([]);
  });
});

describe("invokeBoothTool", () => {
  it("degrades to ok:false when the prism CLI process itself fails", async () => {
    runCliMock.mockResolvedValue({ ok: false, stdout: "", error: "spawn prism ENOENT" });
    const result = await invokeBoothTool("drafts_list", { project_key: "vellum" });
    expect(result).toEqual({ ok: false, error: "spawn prism ENOENT" });
  });

  it("degrades to ok:false with the BoothCliError message on a live 502", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify(mcpEnvelope502) });
    const result = await invokeBoothTool("drafts_list", { project_key: "vellum" });
    expect(result).toEqual({ ok: false, error: "502 Bad Gateway" });
  });

  it("degrades to ok:false and strips the MCP error prefix on a tool-input validation error", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify(mcpEnvelopeValidationError) });
    const result = await invokeBoothTool("drafts_list", {});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.startsWith("MCP error")).toBe(false);
    expect(result.ok === false && result.error).toContain("project_key");
  });

  it("returns ok:true with the tool's data on a well-formed success envelope", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify(mcpEnvelopeSuccess) });
    const result = await invokeBoothTool("drafts_list", { project_key: "vellum" });
    expect(result).toEqual({ ok: true, data: draftRowsFixture });
  });

  it("degrades to ok:false on unparseable stdout", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: "not json" });
    const result = await invokeBoothTool("drafts_list", { project_key: "vellum" });
    expect(result.ok).toBe(false);
  });
});

describe("fetchBoothDrafts", () => {
  it("shells to `prism tools invoke booth drafts_list --input {project_key}`", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify(mcpEnvelopeSuccess) });
    await fetchBoothDrafts("vellum");
    expect(runCliMock).toHaveBeenCalledWith(
      "prism",
      ["tools", "invoke", "booth", "drafts_list", "--input", JSON.stringify({ project_key: "vellum" })],
      expect.any(Number),
    );
  });

  it("captures the live 502-degradation shape end to end", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify(mcpEnvelope502) });
    const result = await fetchBoothDrafts("vellum");
    expect(result).toEqual({ ok: false, error: "502 Bad Gateway", drafts: [] });
  });

  it("maps a successful data array into BoothDraftRow rows", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify(mcpEnvelopeSuccess) });
    const result = await fetchBoothDrafts("vellum");
    expect(result.ok).toBe(true);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]).toMatchObject({ id: "draft_abc123", title: "Launch teaser v2" });
  });

  it("tolerates data nested under an `items` field", async () => {
    const nested = { ok: true, command: "drafts list", data: { items: draftRowsFixture } };
    runCliMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(nested) }], structuredContent: nested }),
    });
    const result = await fetchBoothDrafts("vellum");
    expect(result.ok).toBe(true);
    expect(result.drafts).toHaveLength(2);
  });
});

describe("fetchBoothReview", () => {
  it("rejects a blank comment body without invoking the CLI", async () => {
    const result = await fetchBoothReview("vellum", "draft_1", "comment", "   ");
    expect(result).toEqual({ ok: false, error: "comment requires a non-empty body" });
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it("rejects a blank request_revision body without invoking the CLI", async () => {
    const result = await fetchBoothReview("vellum", "draft_1", "request_revision");
    expect(result).toEqual({ ok: false, error: "request_revision requires a non-empty body" });
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it("allows approve with no body", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify({ content: [], structuredContent: { ok: true, command: "review approve", data: null } }) });
    const result = await fetchBoothReview("vellum", "draft_1", "approve");
    expect(result).toEqual({ ok: true });
    expect(runCliMock).toHaveBeenCalledWith(
      "prism",
      ["tools", "invoke", "booth", "review_approve", "--input", JSON.stringify({ project_key: "vellum", draft_item_id: "draft_1" })],
      expect.any(Number),
    );
  });

  it("includes a trimmed body for review_comment", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify({ content: [], structuredContent: { ok: true, command: "review comment", data: null } }) });
    const result = await fetchBoothReview("vellum", "draft_1", "comment", "  looks good  ");
    expect(result).toEqual({ ok: true });
    expect(runCliMock).toHaveBeenCalledWith(
      "prism",
      ["tools", "invoke", "booth", "review_comment", "--input", JSON.stringify({ project_key: "vellum", draft_item_id: "draft_1", body: "looks good" })],
      expect.any(Number),
    );
  });

  it("relays the 502 error for a review write against the down server", async () => {
    runCliMock.mockResolvedValue({ ok: true, stdout: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ok: false, command: "review approve", error: { type: "BoothCliError", message: "502 Bad Gateway" } }) }], structuredContent: { ok: false, command: "review approve", error: { type: "BoothCliError", message: "502 Bad Gateway" } } }) });
    const result = await fetchBoothReview("vellum", "draft_1", "approve");
    expect(result).toEqual({ ok: false, error: "502 Bad Gateway" });
  });
});
