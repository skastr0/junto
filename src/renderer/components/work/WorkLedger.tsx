import { useMemo, useState } from "react";
import {
  Ban,
  Check,
  Download,
  FileBox,
  FileText,
  Image,
  Link as LinkIcon,
  MessageSquareWarning,
  PanelRightClose,
  Search,
  X,
} from "lucide-react";
import type { Artifact, CanvasNode, Part, Task, WorkMetadata } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
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
import { getVellumApi } from "../../lib/vellum-api";
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

const textOf = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");

const isImagePart = (part: Part): boolean => {
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

function downloadRaw(part: Extract<Part, { kind: "raw" }>, filename: string) {
  const binary = atob(part.bytesBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
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
}: {
  readonly part: Part;
  readonly filename: string;
}) {
  if (part.kind === "text") {
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
            Download
          </Button>
        </div>
      );
    }
    return (
      <div className="work-ledger-part work-ledger-part--raw">
        <FileBox size={18} />
        <div>
          <strong>{part.mediaType ?? "Binary data"}</strong>
          <span>{Math.ceil((part.bytesBase64.length * 3) / 4).toLocaleString()} bytes</span>
        </div>
        <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
          <Download size={11} />
          Save
        </Button>
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
              placeholder="Provide the decision, information, or authorization the agent needs…"
              rows={7}
            />
          </section>
        ) : null}
      </div>
      {request.state === "input-required" ? (
        <footer className="work-ledger-detail__actions">
          <Button
            variant="danger"
            disabled={pending || !response.trim()}
            onClick={() => onResolve(request, response.trim(), "rejected")}
          >
            <Ban size={12} />
            Reject
          </Button>
          <Button
            variant="primary"
            disabled={pending || !response.trim()}
            onClick={() => onResolve(request, response.trim(), "completed")}
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
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const items = node.ether?.requests?.items ?? [];
  const pendingItems = items.filter((request) => request.state === "input-required");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(pendingItems[0]?.id ?? null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const api = getVellumApi();
  const name = canvasName();
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? items.filter((request) =>
        `${requestTitle(request)} ${requestDetails(request) ?? ""}`.toLowerCase().includes(normalized),
      )
    : items;
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
        status={`${pendingItems.length} need you · ${items.length - pendingItems.length} resolved`}
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
                      <strong>{requestTitle(request)}</strong>
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

function ArtifactDetail({
  artifact,
  onClose,
}: {
  readonly artifact: Artifact;
  readonly onClose: () => void;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const kind = artifactKind(artifact);
  return (
    <aside className="work-ledger-detail work-ledger-detail--artifact" aria-label={`Artifact details for ${name}`}>
      <header>
        <div>
          <Chip tone="violet">{kind}</Chip>
          <h2>{name}</h2>
        </div>
        <IconButton aria-label="Close artifact details" title="Close details" onClick={onClose}>
          <PanelRightClose size={15} />
        </IconButton>
      </header>
      <div className="work-ledger-detail__meta">
        <span>#{artifact.artifactId}</span>
        {artifact.task ? <span>Task #{artifact.task.itemId}</span> : null}
      </div>
      <div className="work-ledger-detail__scroll">
        <section>
          <h3>Contents</h3>
          <div className="work-ledger-parts">
            {artifact.parts.map((part, index) => (
              <PartView key={index} part={part} filename={`${name}-${index + 1}`} />
            ))}
          </div>
        </section>
        {artifact.metadata && Object.keys(artifact.metadata).length > 0 ? (
          <section>
            <h3>Metadata</h3>
            <dl className="work-ledger-metadata">
              {Object.entries(artifact.metadata).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.artifactId ?? null);
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      normalized
        ? items.filter((artifact) =>
            `${artifact.name ?? ""} ${artifact.artifactId} ${artifact.task?.itemId ?? ""}`
              .toLowerCase()
              .includes(normalized),
          )
        : items,
    [items, normalized],
  );
  const selected = selectedId
    ? items.find((artifact) => artifact.artifactId === selectedId)
    : undefined;

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Artifacts"
      onClose={onClose}
      panelClassName="work-ledger-surface nowheel"
    >
      <OverlayHeader
        eyebrow="artifacts"
        title="Artifact library"
        status={`${items.length} published output${items.length === 1 ? "" : "s"}`}
        actions={
          <>
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
      <div className="work-ledger-workspace" data-detail-open={selected ? "true" : "false"}>
        <div className="work-ledger-list work-ledger-list--artifacts">
          <section>
            <header>
              <h2>Published</h2>
              <span>{visible.length}</span>
            </header>
            <div role="list">
              {visible.map((artifact) => {
                const kind = artifactKind(artifact);
                const Icon = artifactIcon[kind];
                const name = artifact.name?.trim() || artifact.artifactId;
                return (
                  <button
                    key={artifact.artifactId}
                    type="button"
                    role="listitem"
                    className="work-ledger-row work-ledger-row--artifact"
                    aria-current={selectedId === artifact.artifactId ? "true" : undefined}
                    onClick={() => setSelectedId(artifact.artifactId)}
                  >
                    <span className="work-ledger-row__icon">
                      <Icon size={15} />
                    </span>
                    <span>
                      <strong>{name}</strong>
                      <small>
                        {artifact.task ? `Task #${artifact.task.itemId}` : "Unbound output"} ·{" "}
                        {artifact.parts.length} part{artifact.parts.length === 1 ? "" : "s"}
                      </small>
                    </span>
                    <Chip tone="violet">{kind}</Chip>
                  </button>
                );
              })}
              {visible.length === 0 ? (
                <div className="work-ledger-list__empty">
                  {normalized ? "No matching artifacts" : "No artifacts published yet"}
                </div>
              ) : null}
            </div>
          </section>
        </div>
        {selected ? (
          <ArtifactDetail
            key={selected.artifactId}
            artifact={selected}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </FocusSurface>
  );
}
