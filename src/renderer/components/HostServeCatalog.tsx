/**
 * Tailscale Serve / SVC catalog for a single host (Settings → Hosts).
 * Lists named services + TCP forwards; Open mints a canvas page node.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HerdrServeCatalogInfo, HerdrServeEntryInfo } from "@shared/ipc";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { addNode } from "../lib/mutations";
import { makePageNode } from "../lib/node-factories";
import { resolveAuthoredPageHost } from "../lib/page-authoring";
import { closeSettings } from "../lib/settings-state";
import { state$ } from "../lib/state";
import { getVellumApi } from "../lib/vellum-api";
import { DIM } from "../lib/theme";

export function HostServeCatalog({
  hostId,
  hostLabel,
}: {
  readonly hostId: string;
  readonly hostLabel: string;
}) {
  const [catalog, setCatalog] = useState<HerdrServeCatalogInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [fetched, setFetched] = useState(false);
  const loadGen = useRef(0);

  const load = useCallback(
    async (force: boolean) => {
      type Api = ReturnType<typeof getVellumApi> & {
        herdrServeCatalogGet?: (id: string) => Promise<{
          ok: boolean;
          data?: HerdrServeCatalogInfo;
          message?: string;
        }>;
        herdrServeCatalogRefresh?: (id: string) => Promise<{
          ok: boolean;
          data?: HerdrServeCatalogInfo;
          message?: string;
        }>;
      };
      const api = getVellumApi() as Api | undefined;
      // Prefer refresh when force; Get also awaits a real fetch on main now.
      const fn = force ? api?.herdrServeCatalogRefresh : api?.herdrServeCatalogGet;
      if (!fn) {
        setError("Serve catalog API unavailable");
        setFetched(true);
        return;
      }
      const gen = ++loadGen.current;
      setLoading(true);
      try {
        const result = await fn(hostId);
        if (gen !== loadGen.current) return;
        if (result.ok && result.data) {
          setCatalog(result.data);
          setError(result.data.error);
        } else {
          setError(result.message ?? "Could not load services");
        }
      } catch (err) {
        if (gen !== loadGen.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === loadGen.current) {
          setLoading(false);
          setFetched(true);
        }
      }
    },
    [hostId],
  );

  useEffect(() => {
    if (!expanded) return;
    void load(false);
  }, [expanded, load]);

  const openEntry = (entry: HerdrServeEntryInfo) => {
    const url = entry.publicUrl?.trim();
    if (!url) return;
    const doc = state$.doc.peek();
    // Place near viewport focus or first selected-ish density — use last selected node if any.
    const selectedId = state$.selectedNodeId.peek();
    const selected = selectedId ? doc.nodes.find((n) => n.id === selectedId) : undefined;
    const anchor = selected ?? doc.nodes[doc.nodes.length - 1];
    const width = 260;
    const x = anchor ? Math.round(anchor.x + (anchor.width ?? width) + 40) : 160;
    const y = anchor ? Math.round(anchor.y) : 160;
    const seed = resolvePageSpawnDefaults(doc, x + width / 2, y + 55);
    const page = makePageNode(
      x,
      y,
      url,
      seed?.profile ? { profile: seed.profile } : undefined,
      // Region page defaults are the authorial placement policy. The catalog
      // host remains the deliberate fallback when the region does not select
      // a browser composition host.
      resolveAuthoredPageHost(seed?.host, hostId),
    );
    addNode(page, { edit: false, focus: true });
    closeSettings();
  };

  const services = catalog?.services ?? [];
  const forwards =
    catalog?.entries.filter((e) => e.kind === "tcp-forward" && e.publicUrl) ?? [];
  const webRoots =
    catalog?.entries.filter((e) => e.kind === "web" && (e.path === "/" || !e.path) && e.publicUrl) ??
    [];
  const openableCount = services.length + forwards.length + webRoots.length;
  const showEmpty = fetched && !loading && openableCount === 0 && !error;

  return (
    <div className="settings-host-services">
      <div className="settings-host-services__head">
        <button
          type="button"
          className="settings-panel__ghost settings-host-services__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▾" : "▸"} Services
          {fetched && openableCount > 0 ? (
            <span className="settings-host-services__count">{openableCount}</span>
          ) : null}
        </button>
        {expanded ? (
          <button
            type="button"
            className="settings-panel__ghost"
            disabled={loading}
            onClick={() => void load(true)}
          >
            {loading ? "…" : "refresh"}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="settings-host-services__body">
          {loading && !fetched ? (
            <p className="settings-note">Loading Tailscale Serve…</p>
          ) : null}
          {loading && fetched ? (
            <p className="settings-note">Refreshing…</p>
          ) : null}
          {error ? (
            <p className="settings-host-services__error" role="status">
              {error}
            </p>
          ) : null}
          {showEmpty ? (
            <p className="settings-note">
              No Serve / SVC entries on {hostLabel}. Advertise with{" "}
              <code>tailscale serve</code> on that machine.
            </p>
          ) : null}

          {services.length > 0 ? (
            <ul className="settings-host-services__list" aria-label={`${hostLabel} SVCs`}>
              {services.map((svc) => (
                <li key={svc.id} className="settings-host-services__row">
                  <div className="settings-host-services__meta">
                    <strong>{svc.label}</strong>
                    <span title={svc.publicUrl}>{svc.publicUrl}</span>
                    {svc.localPort !== undefined ? (
                      <span className="settings-host-services__local">→ :{svc.localPort}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="settings-panel__ghost"
                    disabled={!svc.publicUrl}
                    title={svc.publicUrl ? `Open page · ${svc.publicUrl}` : "No public URL"}
                    onClick={() => openEntry(svc)}
                  >
                    open page
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {webRoots.length > 0 ? (
            <>
              <div className="settings-host-services__sub">Machine HTTPS</div>
              <ul className="settings-host-services__list">
                {webRoots.map((w) => (
                  <li key={w.id} className="settings-host-services__row">
                    <div className="settings-host-services__meta">
                      <strong>{w.label}</strong>
                      <span title={w.publicUrl}>{w.publicUrl}</span>
                    </div>
                    <button
                      type="button"
                      className="settings-panel__ghost"
                      disabled={!w.publicUrl}
                      title={w.publicUrl ? `Open page · ${w.publicUrl}` : undefined}
                      onClick={() => openEntry(w)}
                    >
                      open page
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {forwards.length > 0 ? (
            <>
              <div className="settings-host-services__sub">TCP forwards</div>
              <ul className="settings-host-services__list">
                {forwards.map((f) => (
                  <li key={f.id} className="settings-host-services__row">
                    <div className="settings-host-services__meta">
                      <strong>{f.label}</strong>
                      <span title={f.publicUrl}>{f.publicUrl}</span>
                    </div>
                    <button
                      type="button"
                      className="settings-panel__ghost"
                      disabled={!f.publicUrl}
                      title={
                        f.publicUrl
                          ? `Open page · ${f.publicUrl} (may be non-HTTP)`
                          : undefined
                      }
                      onClick={() => openEntry(f)}
                    >
                      open page
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="settings-host-services__hint" style={{ color: DIM }}>
            From <code>tailscale serve status</code> on {hostId}. Open page places a browser
            node on the canvas.
          </p>
        </div>
      ) : null}
    </div>
  );
}
