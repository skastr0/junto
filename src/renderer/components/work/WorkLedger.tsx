import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Ban,
  Check,
  Download,
  FileBox,
  FileText,
  Image,
  Link as LinkIcon,
  Maximize2,
  MessageSquareWarning,
  PanelRightClose,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Artifact, CanvasNode, Part, Task, WorkMetadata } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import { isArtifactArchived } from "@shared/work";
import { taskBrief } from "@shared/task";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Input, Textarea } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { StatusDot } from "../ui/StatusDot";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import {
  artifactSearchText,
  artifactTaskReferenceLabel,
} from "./artifact-reference";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { ContentMedia } from "./ContentMedia";
import "./work-ledger.css";

const canvasName = (): string => state$.canvasName.peek() || "";

const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

const runWorkCanvasMutation = <T,>(
  canvas: string,
  operation: () => Promise<WorkOpResult<T>>,
): Promise<WorkOpResult<T> | undefined> =>
  runCanvasAuthoringOperation(async () => acceptWorkResult(canvas, await operation()));

const metadataText = (
  metadata: WorkMetadata | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const requestTitle = (request: Task): string =>
  metadataText(request.metadata, "title") ??
  taskBrief(request).split(/\r?\n/, 1)[0]?.trim() ??
  "Untitled request";

const requestDetails = (request: Task): string | undefined =>
  metadataText(request.metadata, "details");

/** List titles clip at this length; full text lives in the detail pane. */
const REQUEST_TITLE_LIST_LIMIT = 72;

/** Newer requests first (ULID time order = birth order). */
const compareRequestsNewestFirst = (a: Task, b: Task): number =>
  b.id.localeCompare(a.id);

function RequestListTitle({ title }: { readonly title: string }) {
  const [expanded, setExpanded] = useState(false);
  if (title.length <= REQUEST_TITLE_LIST_LIMIT) {
    return <strong className="work-ledger-row__title">{title}</strong>;
  }
  if (expanded) {
    return (
      <strong className="work-ledger-row__title work-ledger-row__title--expanded">
        {title}{" "}
        <button
          type="button"
          className="work-ledger-read-more"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(false);
          }}
        >
          less
        </button>
      </strong>
    );
  }
  return (
    <strong className="work-ledger-row__title">
      {`${title.slice(0, REQUEST_TITLE_LIST_LIMIT).trimEnd()}…`}{" "}
      <button
        type="button"
        className="work-ledger-read-more"
        onClick={(event) => {
          event.stopPropagation();
          setExpanded(true);
        }}
      >
        read more
      </button>
    </strong>
  );
}

const textOf = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");

const isImagePart = (part: Part): boolean => {
  if (part.kind === "content" && part.ref.mediaType.startsWith("image/")) {
    return true;
  }
  if (part.kind === "url" && part.mediaType?.startsWith("image/")) return true;
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) return true;
  return part.kind === "url" && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(part.url);
};

const imageSrc = (part: Part): string | undefined => {
  if (part.kind === "url" && isImagePart(part)) return part.url;
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) {
    return `data:${part.mediaType};base64,${part.bytesBase64}`;
  }
  return undefined;
};

const isTextMediaType = (mediaType: string | undefined): boolean => {
  if (mediaType === undefined) return false;
  const [top] = mediaType.split(";");
  const clean = top.trim().toLowerCase();
  if (clean.startsWith("text/")) return true;
  if (clean.endsWith("+json") || clean.endsWith("+xml")) return true;
  const known = new Set([
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/ecmascript",
    "application/typescript",
    "application/x-sh",
    "application/x-csh",
    "application/x-python",
    "application/x-python-code",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
  ]);
  return known.has(clean);
};

const isMarkdownMediaType = (mediaType: string | undefined): boolean => {
  if (mediaType === undefined) return false;
  const clean = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    clean === "text/markdown" ||
    clean === "application/markdown" ||
    clean === "text/x-markdown" ||
    clean === "application/x-md"
  );
};

const isMarkdownFilename = (filename: string): boolean =>
  /\.(?:md|markdown|mdown|mkdn)$/iu.test(filename.trim());

const bytesOfBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const formatBytes = (count: number): string => `${count.toLocaleString()} bytes`;

function downloadRaw(part: Extract<Part, { kind: "raw" }>, filename: string) {
  const bytes = bytesOfBase64(part.bytesBase64) as Uint8Array<ArrayBuffer>;
  const file = new Blob([bytes], { type: part.mediaType ?? "application/octet-stream" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function PartView({
  part,
  filename,
  markdown = false,
}: {
  readonly part: Part;
  readonly filename: string;
  readonly markdown?: boolean;
}) {
  const bytes = useMemo(() => {
    if (part.kind === "raw" && !isImagePart(part)) return bytesOfBase64(part.bytesBase64);
    return undefined;
  }, [part]);

  const text = useMemo(() => {
    if (part.kind !== "raw" || bytes === undefined) return undefined;
    if (part.mediaType && !isTextMediaType(part.mediaType)) return undefined;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (part.mediaType) return decoded;
      if (decoded.includes("\0")) return undefined;
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded)) return undefined;
      return decoded;
    } catch {
      return undefined;
    }
  }, [part, bytes]);

  if (part.kind === "text") {
    if (markdown) {
      return (
        <div className="work-ledger-part work-ledger-part--markdown">
          <ArtifactMarkdown source={part.text} />
        </div>
      );
    }
    return <pre className="work-ledger-part work-ledger-part--text">{part.text}</pre>;
  }
  if (part.kind === "url") {
    const src = imageSrc(part);
    if (src) {
      return (
        <a className="work-ledger-part work-ledger-part--image" href={part.url} target="_blank" rel="noreferrer">
          <img src={src} alt={filename} />
          <span>
            <LinkIcon size={12} />
            Open original
          </span>
        </a>
      );
    }
    return (
      <a className="work-ledger-part work-ledger-part--link" href={part.url} target="_blank" rel="noreferrer">
        <LinkIcon size={13} />
        <span>{part.url}</span>
      </a>
    );
  }
  if (part.kind === "raw") {
    const src = imageSrc(part);
    if (src) {
      return (
        <div className="work-ledger-part work-ledger-part--image">
          <img src={src} alt={filename} />
          <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
            <Download size={11} />
            Save
          </Button>
        </div>
      );
    }
    if (text !== undefined && bytes !== undefined) {
      return (
        <div className="work-ledger-part work-ledger-part--raw-text">
          <div className="work-ledger-part__bar">
            <FileText size={13} />
            <span className="work-ledger-part__type">{part.mediaType ?? "text"}</span>
            <span className="work-ledger-part__bytes">{formatBytes(bytes.length)}</span>
            <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
              <Download size={11} />
              Save
            </Button>
          </div>
          {markdown || isMarkdownMediaType(part.mediaType) || isMarkdownFilename(filename) ? (
            <div className="work-ledger-part__body work-ledger-part__body--markdown">
              <ArtifactMarkdown source={text} />
            </div>
          ) : (
            <pre className="work-ledger-part__body">{text}</pre>
          )}
        </div>
      );
    }
    return (
      <div className="work-ledger-part work-ledger-part--raw">
        <FileBox size={18} />
        <div>
          <strong>{part.mediaType ?? "Binary data"}</strong>
          <span>{formatBytes(bytes?.length ?? 0)}</span>
        </div>
        <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
          <Download size={11} />
          Save
        </Button>
      </div>
    );
  }
  if (part.kind === "content") {
    return (
      <div className="work-ledger-part work-ledger-part--content">
        <ContentMedia
          contentRef={part.ref}
          alt={part.ref.displayName ?? filename}
          renderMarkdown={
            markdown ||
            isMarkdownMediaType(part.ref.mediaType) ||
            isMarkdownFilename(part.ref.displayName ?? filename)
          }
        />
      </div>
    );
  }
  return (
    <pre className="work-ledger-part work-ledger-part--data">
      {JSON.stringify(part.data, null, 2)}
    </pre>
  );
}

function RequestDetail({
  request,
  pending,
  onClose,
  onResolve,
}: {
  readonly request: Task;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onResolve: (request: Task, response: string, disposition: "completed" | "rejected") => void;
}) {
  const [response, setResponse] = useState("");
  const details = requestDetails(request);
  const attachments = request.history
    .flatMap((message) => message.parts)
    .filter((part) => part.kind !== "text");
  const canSend = !pending && response.trim().length > 0;
  const sendResponse = (): void => {
    if (!canSend) return;
    onResolve(request, response.trim(), "completed");
  };

  return (
    <aside className="work-ledger-detail" aria-label={`Request details for ${requestTitle(request)}`}>
      <header>
        <div>
          <Chip tone={request.state === "input-required" ? "amber" : request.state === "completed" ? "green" : "crimson"}>
            {request.state === "input-required" ? "Needs input" : request.state}
          </Chip>
          <h2>{requestTitle(request)}</h2>
        </div>
        <IconButton aria-label="Close request details" title="Close details" onClick={onClose}>
          <PanelRightClose size={15} />
        </IconButton>
      </header>
      <div className="work-ledger-detail__meta">#{request.id}</div>
      <div className="work-ledger-detail__scroll">
        <section>
          <h3>Context</h3>
          <p className={details ? "" : "work-ledger-empty"}>
            {details ?? "No additional context was provided."}
          </p>
        </section>
        {attachments.length > 0 ? (
          <section>
            <h3>Attachments</h3>
            <div className="work-ledger-parts">
              {attachments.map((part, index) => (
                <PartView key={index} part={part} filename={`${requestTitle(request)}-${index + 1}`} />
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>Activity</h3>
          <ol className="work-ledger-activity">
            {request.history.map((message, index) => (
              <li key={message.messageId}>
                <StatusDot tone={index === 0 ? "amber" : message.role === "agent" ? "cyan" : "green"} />
                <div>
                  <strong>{index === 0 ? "Request opened" : message.role === "agent" ? "Agent" : "Operator"}</strong>
                  <p>{textOf(message.parts) || "Attached structured context."}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        {request.state === "input-required" ? (
          <section>
            <h3>Your response</h3>
            <Textarea
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (!(event.metaKey || event.ctrlKey)) return;
                event.preventDefault();
                sendResponse();
              }}
              placeholder="Provide the decision, information, or authorization the agent needs…"
              rows={7}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            />
            <p className="work-ledger-detail__shortcut-hint">
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
              {" "}
              send response
            </p>
          </section>
        ) : null}
      </div>
      {request.state === "input-required" ? (
        <footer className="work-ledger-detail__actions">
          <Button
            variant="danger"
            disabled={!canSend}
            onClick={() => onResolve(request, response.trim(), "rejected")}
          >
            <Ban size={12} />
            Reject
          </Button>
          <Button
            variant="primary"
            disabled={!canSend}
            onClick={sendResponse}
            title="⌘↵ / Ctrl+Enter"
          >
            <Check size={12} />
            Send response
          </Button>
        </footer>
      ) : null}
    </aside>
  );
}

export function RequestInbox({
  node,
  onClose,
  initialItemId,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
  /** Pre-select this request when opened from jump-to-cause. */
  readonly initialItemId?: string;
}) {
  const items = useMemo(
    () => [...(node.ether?.requests?.items ?? [])].sort(compareRequestsNewestFirst),
    [node.ether?.requests?.items],
  );
  const pendingItems = items.filter((request) => request.state === "input-required");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (initialItemId && items.some((request) => request.id === initialItemId)) {
      return initialItemId;
    }
    return pendingItems[0]?.id ?? null;
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const api = getVellumCommandApi();
  const name = canvasName();
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const filtered = normalized
      ? items.filter((request) =>
          `${requestTitle(request)} ${requestDetails(request) ?? ""}`
            .toLowerCase()
            .includes(normalized),
        )
      : items;
    return filtered;
  }, [items, normalized]);
  const selected = selectedId ? items.find((request) => request.id === selectedId) : undefined;

  const resolve = async (
    request: Task,
    response: string,
    disposition: "completed" | "rejected",
  ) => {
    if (!api) return;
    setPendingId(request.id);
    setError("");
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workRequestResolve(name, node.id, request.id, response, disposition),
      );
      if (result === undefined) return;
      if (!result.ok) setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Input requests"
      onClose={onClose}
      panelClassName="work-ledger-surface nowheel"
    >
      <OverlayHeader
        eyebrow="requests"
        title="Input requests"
        status={`${pendingItems.length} need you - ${items.length - pendingItems.length} resolved`}
        actions={
          <>
            <div className="work-ledger-search">
              <Search size={13} aria-hidden />
              <Input
                aria-label="Search input requests"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search requests"
              />
            </div>
            <IconButton aria-label="Close input requests" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          </>
        }
      />
      {error ? (
        <div className="work-ledger-error" role="alert">
          <MessageSquareWarning size={14} />
          {error}
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="work-ledger-workspace" data-detail-open={selected ? "true" : "false"}>
        <div className="work-ledger-list">
          {[
            ["Needs your input", visible.filter((request) => request.state === "input-required")],
            ["Resolved", visible.filter((request) => request.state !== "input-required")],
          ].map(([label, requests]) => (
            <section key={label as string}>
              <header>
                <h2>{label as string}</h2>
                <span>{(requests as Task[]).length}</span>
              </header>
              <div role="list">
                {(requests as Task[]).map((request) => (
                  <button
                    key={request.id}
                    type="button"
                    role="listitem"
                    className="work-ledger-row"
                    aria-current={selectedId === request.id ? "true" : undefined}
                    onClick={() => setSelectedId(request.id)}
                  >
                    <StatusDot
                      tone={
                        request.state === "input-required"
                          ? "amber"
                          : request.state === "completed"
                            ? "green"
                            : "crimson"
                      }
                    />
                    <span>
                      <RequestListTitle title={requestTitle(request)} />
                      <small>{requestDetails(request) ?? `Request ${request.id}`}</small>
                    </span>
                    <Chip
                      tone={
                        request.state === "input-required"
                          ? "amber"
                          : request.state === "completed"
                            ? "green"
                            : "crimson"
                      }
                    >
                      {request.state === "input-required" ? "Needs input" : request.state}
                    </Chip>
                  </button>
                ))}
                {(requests as Task[]).length === 0 ? (
                  <div className="work-ledger-list__empty">
                    {normalized ? "No matching requests" : `No ${String(label).toLowerCase()}`}
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
        {selected ? (
          <RequestDetail
            key={selected.id}
            request={selected}
            pending={pendingId === selected.id}
            onClose={() => setSelectedId(null)}
            onResolve={(request, response, disposition) =>
              void resolve(request, response, disposition)
            }
          />
        ) : null}
      </div>
    </FocusSurface>
  );
}

const artifactKind = (artifact: Artifact): "image" | "link" | "document" | "data" => {
  if (artifact.parts.some(isImagePart)) return "image";
  if (artifact.parts.some((part) => part.kind === "url")) return "link";
  if (artifact.parts.some((part) => part.kind === "text")) return "document";
  return "data";
};

const artifactIcon = {
  image: Image,
  link: LinkIcon,
  document: FileText,
  data: FileBox,
} as const;

/** Shared body for side detail + expanded focus modal. */
function ArtifactContents({
  artifact,
  bodyTestId,
}: {
  readonly artifact: Artifact;
  readonly bodyTestId?: string;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const kind = artifactKind(artifact);
  const metaEntries = Object.entries(artifact.metadata ?? {}).filter(
    ([key]) => key !== "archived",
  );
  return (
    <>
      <div className="artifact-focus__meta" data-testid="artifact-focus-meta">
        <span className="artifact-focus__meta-id">#{artifact.artifactId}</span>
        <span>
          {artifact.parts.length} part{artifact.parts.length === 1 ? "" : "s"}
        </span>
        {kind !== "image" ? (
          <span className="artifact-focus__meta-kind">{kind}</span>
        ) : null}
        {isArtifactArchived(artifact) ? (
          <Chip tone="steel">archived</Chip>
        ) : null}
      </div>
      <div
        className="artifact-focus__scroll"
        data-testid={bodyTestId ?? "artifact-focus-body"}
      >
        <section>
          <h3>Contents</h3>
          <div className="work-ledger-parts artifact-focus__parts">
            {artifact.parts.map((part, index) => {
              const filename = `${name}-${index + 1}`;
              return (
                <PartView
                  key={index}
                  part={part}
                  filename={filename}
                  markdown={
                    part.kind === "text" ||
                    isMarkdownFilename(name) ||
                    (part.kind === "raw" && isMarkdownMediaType(part.mediaType)) ||
                    (part.kind === "content" && isMarkdownMediaType(part.ref.mediaType))
                  }
                />
              );
            })}
          </div>
        </section>
        {metaEntries.length > 0 ? (
          <section>
            <h3>Metadata</h3>
            <dl className="work-ledger-metadata">
              {metaEntries.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
    </>
  );
}

/**
 * Immersive reader — only opened from the expand / zoom control.
 * Default selection uses the in-library side pane, not this modal.
 */
function ArtifactFocusModal({
  artifact,
  onClose,
}: {
  readonly artifact: Artifact;
  readonly onClose: () => void;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const kind = artifactKind(artifact);
  return (
    <FocusSurface
      measure="document"
      height="immersive"
      layer="work"
      label={name}
      onClose={onClose}
      panelClassName="artifact-focus nowheel"
    >
      <OverlayHeader
        eyebrow={`artifact - ${kind}`}
        title={name}
        status={artifactTaskReferenceLabel(artifact) ?? undefined}
        actions={
          <IconButton aria-label="Close artifact" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <ArtifactContents artifact={artifact} />
    </FocusSurface>
  );
}

/** In-library side detail (~80% of the surface). */
function ArtifactSideDetail({
  artifact,
  pending,
  onExpand,
  onArchive,
  onDelete,
}: {
  readonly artifact: Artifact;
  readonly pending: boolean;
  readonly onExpand: () => void;
  readonly onArchive: (archived: boolean) => void;
  readonly onDelete: () => void;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const kind = artifactKind(artifact);
  const archived = isArtifactArchived(artifact);
  return (
    <aside
      className="work-ledger-detail work-ledger-detail--artifact"
      aria-label={`Artifact ${name}`}
      data-testid="artifact-side-detail"
    >
      <header>
        <div>
          <Chip tone="violet">{kind}</Chip>
          {archived ? <Chip tone="steel">archived</Chip> : null}
          <h2>{name}</h2>
        </div>
        <div className="work-ledger-detail__actions">
          <IconButton
            aria-label="Expand artifact"
            title="Expand"
            onClick={onExpand}
            disabled={pending}
          >
            <Maximize2 size={14} />
          </IconButton>
          <IconButton
            aria-label={archived ? "Restore artifact" : "Archive artifact"}
            title={archived ? "Restore" : "Archive"}
            onClick={() => onArchive(!archived)}
            disabled={pending}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </IconButton>
          <IconButton
            aria-label="Delete artifact"
            title="Delete"
            onClick={onDelete}
            disabled={pending}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      </header>
      <ArtifactContents artifact={artifact} bodyTestId="artifact-side-body" />
    </aside>
  );
}

export function ArtifactLibrary({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const items = node.ether?.artifacts?.items ?? [];
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  /** Selected for the side pane (not the expand modal). */
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const firstLive = items.find((item) => !isArtifactArchived(item));
    return firstLive?.artifactId ?? items[0]?.artifactId ?? null;
  });
  /** Expanded immersive reader only. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const api = getVellumCommandApi();
  const name = canvasName();
  const normalized = query.trim().toLowerCase();
  const archivedCount = items.filter(isArtifactArchived).length;
  const liveCount = items.length - archivedCount;

  const visible = useMemo(() => {
    const base = showArchived
      ? items
      : items.filter((artifact) => !isArtifactArchived(artifact));
    if (!normalized) return base;
    return base.filter((artifact) =>
      artifactSearchText(artifact).toLowerCase().includes(normalized),
    );
  }, [items, normalized, showArchived]);

  // Keep selection valid when list filters or items change.
  useEffect(() => {
    if (selectedId && visible.some((a) => a.artifactId === selectedId)) return;
    setSelectedId(visible[0]?.artifactId ?? null);
  }, [visible, selectedId]);

  const selected = selectedId
    ? items.find((artifact) => artifact.artifactId === selectedId)
    : undefined;
  const expanded = expandedId
    ? items.find((artifact) => artifact.artifactId === expandedId)
    : undefined;

  const runArtifactMutation = async (
    artifactId: string,
    operation: () => Promise<WorkOpResult<unknown>>,
  ): Promise<void> => {
    if (!api) return;
    setPendingId(artifactId);
    setError("");
    try {
      const result = await runWorkCanvasMutation(name, operation);
      if (result === undefined) return;
      if (!result.ok) setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  };

  const archiveArtifact = (artifact: Artifact, archived: boolean): void => {
    if (!api) return;
    void runArtifactMutation(artifact.artifactId, () =>
      api.workArtifactArchive(name, node.id, artifact.artifactId, archived),
    );
  };

  const deleteArtifact = (artifact: Artifact): void => {
    if (!api) return;
    const label = artifact.name?.trim() || artifact.artifactId;
    if (!window.confirm(`Delete artifact “${label}”? This cannot be undone.`)) {
      return;
    }
    void runArtifactMutation(artifact.artifactId, () =>
      api.workArtifactDelete(name, node.id, artifact.artifactId),
    ).then(() => {
      if (selectedId === artifact.artifactId) setSelectedId(null);
      if (expandedId === artifact.artifactId) setExpandedId(null);
    });
  };

  return (
    <>
      <FocusSurface
        measure="workspace"
        height="immersive"
        layer="work"
        label="Artifacts"
        onClose={onClose}
        closeOnEscape={expanded === undefined}
        closeOnBackdrop={expanded === undefined}
        panelClassName="work-ledger-surface work-ledger-surface--artifacts nowheel"
      >
        <OverlayHeader
          eyebrow="artifacts"
          title="Artifact library"
          status={`${liveCount} active${archivedCount > 0 ? ` - ${archivedCount} archived` : ""}`}
          actions={
            <>
              <Button
                size="xs"
                variant={showArchived ? "primary" : "subtle"}
                aria-pressed={showArchived}
                data-testid="artifact-show-archived"
                onClick={() => setShowArchived((value) => !value)}
              >
                <Archive size={12} />
                {showArchived ? "Hide archived" : "Show archived"}
              </Button>
              <div className="work-ledger-search">
                <Search size={13} aria-hidden />
                <Input
                  aria-label="Search artifacts"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search artifacts"
                />
              </div>
              <IconButton aria-label="Close artifacts" title="Close" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </>
          }
        />
        {error ? (
          <div className="work-ledger-error" role="alert">
            <MessageSquareWarning size={14} />
            {error}
            <button type="button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        ) : null}
        <div
          className="work-ledger-workspace work-ledger-workspace--artifacts"
          data-detail-open={selected ? "true" : "false"}
        >
          <div className="work-ledger-list work-ledger-list--artifacts-rail">
            <section>
              <header>
                <h2>{showArchived ? "All" : "Published"}</h2>
                <span>{visible.length}</span>
              </header>
              <div role="list">
                {visible.map((artifact) => {
                  const kind = artifactKind(artifact);
                  const Icon = artifactIcon[kind];
                  const rowName = artifact.name?.trim() || artifact.artifactId;
                  const isSelected = selectedId === artifact.artifactId;
                  const archived = isArtifactArchived(artifact);
                  return (
                    <div
                      key={artifact.artifactId}
                      role="listitem"
                      className={[
                        "work-ledger-row",
                        "work-ledger-row--artifact",
                        "work-ledger-row--artifact-compact",
                        archived ? "is-archived" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-current={isSelected ? "true" : undefined}
                      data-testid="artifact-row"
                      data-artifact-id={artifact.artifactId}
                    >
                      <button
                        type="button"
                        className="work-ledger-row__select"
                        aria-label={`Select ${rowName}`}
                        onClick={() => setSelectedId(artifact.artifactId)}
                      >
                        <span className="work-ledger-row__icon">
                          <Icon size={14} />
                        </span>
                        <span>
                          <strong>{rowName}</strong>
                          <small>
                            {[
                              archived ? "archived" : undefined,
                              artifactTaskReferenceLabel(artifact),
                              `${artifact.parts.length} part${artifact.parts.length === 1 ? "" : "s"}`,
                            ]
                              .filter(Boolean)
                              .join(" - ")}
                          </small>
                        </span>
                        <Chip tone={archived ? "steel" : "violet"}>{kind}</Chip>
                      </button>
                      <button
                        type="button"
                        className="work-ledger-row__expand"
                        title="Expand"
                        aria-label={`Expand ${rowName}`}
                        data-testid="artifact-row-expand"
                        onClick={() => {
                          setSelectedId(artifact.artifactId);
                          setExpandedId(artifact.artifactId);
                        }}
                      >
                        <Maximize2 size={12} />
                      </button>
                    </div>
                  );
                })}
                {visible.length === 0 ? (
                  <div className="work-ledger-list__empty">
                    {normalized
                      ? "No matching artifacts"
                      : showArchived
                        ? "No artifacts yet"
                        : archivedCount > 0
                          ? "No active artifacts — show archived to browse"
                          : "No artifacts published yet"}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
          {selected ? (
            <ArtifactSideDetail
              key={selected.artifactId}
              artifact={selected}
              pending={pendingId === selected.artifactId}
              onExpand={() => setExpandedId(selected.artifactId)}
              onArchive={(archived) => archiveArtifact(selected, archived)}
              onDelete={() => deleteArtifact(selected)}
            />
          ) : (
            <div className="work-ledger-detail work-ledger-detail--empty" aria-hidden>
              <p>Select an artifact to preview</p>
            </div>
          )}
        </div>
      </FocusSurface>

      {expanded ? (
        <ArtifactFocusModal
          key={expanded.artifactId}
          artifact={expanded}
          onClose={() => setExpandedId(null)}
        />
      ) : null}
    </>
  );
}
