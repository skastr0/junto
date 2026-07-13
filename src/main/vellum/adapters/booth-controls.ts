import type { BoothDraftRow, BoothDraftsResult, BoothReviewAction, SourceWriteResult } from "@shared/ipc";
import { parseJson, runCli } from "./exec";

// Deliberate Booth writes (review verdicts) plus the drafts list that feeds
// the review UI. Distinct from adapters/booth.ts (read-only project/draft
// *counts* for the portfolio snapshot, shelling straight to the `booth` CLI):
// this adapter goes through `prism tools invoke booth <tool>` so every call
// carries the same typed BoothCommandResult envelope and so review writes
// get the tool layer's input validation before anything reaches the server.
//
// LIVE STATUS (2026-07-12): the Booth Control server 502s on every call —
// tracked as a port collision, BC-201. Every function below degrades to
// `ok:false` with the envelope's error string; live verification of the
// success path (parsing a real drafts_list `data` array, confirming a real
// review write) is pending BC-201 landing. Parsers are unit-tested against
// fixtures shaped from the checked-in booth-control schema instead
// (convex/booth.ts's listDraftFeedInternal: draftItemId/title/status/
// mediaKind/updatedAt) and from prism-plugins/booth's BoothCommandResult
// envelope, both read directly, not guessed.

const INVOKE_TIMEOUT_MS = 45_000;

interface McpInvokeContentItem {
  readonly type?: string;
  readonly text?: string;
}

// `prism tools invoke <plugin> <tool> --input '<json>'` always exits 0 and
// prints this envelope to stdout — including when the tool call itself
// failed (isError:true) or the underlying booth CLI/server failed
// (structuredContent.ok:false). The process exit code alone never tells you
// whether the call succeeded; the envelope's isError/ok fields do.
interface McpInvokeEnvelope {
  readonly content?: ReadonlyArray<McpInvokeContentItem>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

// Mirrors prism-plugins/booth/schemas/tool-schemas.ts's BoothCommandResult
// (the stable envelope every booth_* tool returns via structuredContent).
interface BoothCommandResult {
  readonly ok: boolean;
  readonly command?: string;
  readonly data?: unknown;
  readonly error?: { readonly type?: string; readonly message?: string };
}

const MCP_ERROR_PREFIX_RE = /^MCP error -?\d+:\s*/;

type InvokeOutcome = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string };

// Shells to `prism tools invoke booth <tool> --input <json>`, unwraps the MCP
// envelope, then the BoothCommandResult envelope inside it, and reports one
// flat ok/error result. Never throws — every failure mode (CLI unreachable,
// malformed stdout, tool-input validation error, booth CLI/server failure)
// degrades to { ok: false, error }.
export const invokeBoothTool = async (
  tool: string,
  input: Record<string, unknown>,
): Promise<InvokeOutcome> => {
  const result = await runCli(
    "prism",
    ["tools", "invoke", "booth", tool, "--input", JSON.stringify(input)],
    INVOKE_TIMEOUT_MS,
  );
  if (!result.ok) {
    return { ok: false, error: result.error ?? "prism tools invoke failed" };
  }

  const envelope = parseJson<McpInvokeEnvelope>(result.stdout);
  if (!envelope) {
    return { ok: false, error: "unexpected response shape from `prism tools invoke booth`" };
  }

  if (envelope.isError) {
    const raw = envelope.content?.[0]?.text ?? "booth tool invocation failed";
    return { ok: false, error: raw.replace(MCP_ERROR_PREFIX_RE, "") };
  }

  const outcome: BoothCommandResult | undefined =
    envelope.structuredContent && typeof envelope.structuredContent === "object"
      ? (envelope.structuredContent as BoothCommandResult)
      : parseJson<BoothCommandResult>(envelope.content?.[0]?.text ?? "");

  if (!outcome) {
    return { ok: false, error: "unexpected response shape from booth tool" };
  }
  if (!outcome.ok) {
    return { ok: false, error: outcome.error?.message ?? "booth command failed" };
  }
  return { ok: true, data: outcome.data };
};

// --- drafts list --------------------------------------------------------

// Defensive: tolerates a bare array, or the array nested under rows/items/
// drafts/data — the live shape hasn't been observed yet (BC-201).
const asRowArray = (value: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const field of ["rows", "items", "drafts", "data"]) {
      const candidate = (value as Record<string, unknown>)[field];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
};

// Field names read straight off booth-control/convex/booth.ts's draftItems
// rows (draftItemId, title, status, mediaKind, createdAt/updatedAt), plus an
// `id`/`kind` fallback in case a future server revision renames them.
interface RawBoothDraftRow {
  readonly draftItemId?: unknown;
  readonly id?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly mediaKind?: unknown;
  readonly kind?: unknown;
  readonly updatedAt?: unknown;
  readonly createdAt?: unknown;
}

const asOptionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const toIsoOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

// Drops any row missing an id or title instead of emitting a half-populated
// BoothDraftRow — a malformed row is noise, not a partial result worth
// showing.
export const mapBoothDraftRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<BoothDraftRow> =>
  rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const raw = row as RawBoothDraftRow;
    const id = asOptionalString(raw.draftItemId) ?? asOptionalString(raw.id);
    const title = asOptionalString(raw.title);
    if (!id || !title) return [];
    const entry: BoothDraftRow = {
      id,
      title,
      status: asOptionalString(raw.status),
      kind: asOptionalString(raw.mediaKind) ?? asOptionalString(raw.kind),
      updatedAt: toIsoOrUndefined(raw.updatedAt) ?? toIsoOrUndefined(raw.createdAt),
    };
    return [entry];
  });

export const fetchBoothDrafts = async (projectKey: string): Promise<BoothDraftsResult> => {
  const outcome = await invokeBoothTool("drafts_list", { project_key: projectKey });
  if (!outcome.ok) {
    return { ok: false, error: outcome.error, drafts: [] };
  }
  return { ok: true, drafts: mapBoothDraftRows(asRowArray(outcome.data)) };
};

// --- review actions -------------------------------------------------------

// Field names verified live (2026-07-12) via empty-input validation errors
// against each booth_review_* tool: project_key, draft_item_id, body.
const REVIEW_TOOL_BY_ACTION: Record<BoothReviewAction, string> = {
  approve: "review_approve",
  reject: "review_reject",
  comment: "review_comment",
  request_revision: "review_request_revision",
};

// approve/reject accept an optional body; comment/request_revision require
// one (booth_review_comment and booth_review_request_revision both 400 on a
// missing body per prism-plugins/booth/schemas/tool-schemas.ts).
const REVIEW_ACTIONS_REQUIRING_BODY: ReadonlySet<BoothReviewAction> = new Set(["comment", "request_revision"]);

export const fetchBoothReview = async (
  projectKey: string,
  draftId: string,
  action: BoothReviewAction,
  body?: string,
): Promise<SourceWriteResult> => {
  const trimmedBody = body?.trim();
  if (REVIEW_ACTIONS_REQUIRING_BODY.has(action) && !trimmedBody) {
    return { ok: false, error: `${action} requires a non-empty body` };
  }

  const input: Record<string, unknown> = { project_key: projectKey, draft_item_id: draftId };
  if (trimmedBody) input.body = trimmedBody;

  const outcome = await invokeBoothTool(REVIEW_TOOL_BY_ACTION[action], input);
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
};
