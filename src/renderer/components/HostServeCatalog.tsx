/**
 * Tailscale Serve / SVC catalog for a single host (Settings → Hosts).
 * Lists named services + TCP forwards; Open mints a canvas page node.
 */
import { useCallback, useEffect, useState } from "react";
import type { HerdrServeCatalogInfo, HerdrServeEntryInfo } from "@shared/ipc";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { addNode } from "../lib/mutations";
import { makePageNode } from "../lib/node-factories";
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
      const fn = force ? api?.herdrServeCatalogRefresh : api?.herdrServeCatalogGet;
      if (!fn) {
        setError("Serve catalog API unavailable");
        return;
      }
      setLoading(true);
      try {
        const result = await fn(hostId);
        if (result.ok && result.data) {
          setCatalog(result.data);
          setError(result.data.error);
        } else {
          setError(result.message ?? "Could not load services");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
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
    // Fan new pages near viewport center of existing nodes
    const nodes = doc.nodes;
    const baseX =
      nodes.length > 0
        ? Math.round(nodes.reduce((s, n) => s + n.x, 0) / nodes.length) + 80
        : 120;
    const baseY =
      nodes.length > 0
        ? Math.round(nodes.reduce((s, n) => s + n.y, 0) / nodes.length) + 40
        : 120;
    const jitter = Math.floor(Math.random() * 60);
    const x = baseX + jitter;
    const y = baseY + (jitter % 40);
    const seed = resolvePageSpawnDefaults(doc, x + 130, y + 55);
    const page = makePageNode(x, y, url, seed?.profile ? { profile: seed.profile } : undefined);
    // Title the first line via link node — keep url; optional note in ether not available.
    // Stamp a readable label by using text is wrong for link nodes; page uses url field.
    addNode(page, { edit: false, focus: true });
    closeSettings();
  };

  const services = catalog?.services ?? [];
  const forwards =
    catalog?.entries.filter((e) => e.kind === "tcp-forward" && e.publicUrl) ?? [];
  const webRoots =
    catalog?.entries.filter((e) => e.kind === "web" && (e.path === "/" || !e.path) && e.publicUrl) ??
    [];

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
          {services.length > 0 ? (
            <span className="settings-host-services__count">{services.length}</span>
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
          {loading && !catalog ? (
            <p className="settings-note">Loading Tailscale Serve…</p>
          ) : null}
          {error ? (
            <p className="settings-host-services__error" role="status">
              {error}
            </p>
          ) : null}
          {!loading && catalog && services.length === 0 && forwards.length === 0 && webRoots.length === 0 ? (
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
                    title={svc.publicUrl ? `Open ${svc.publicUrl}` : "No public URL"}
                    onClick={() => openEntry(svc)}
                  >
                    open
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
                      onClick={() => openEntry(w)}
                    >
                      open
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
                      onClick={() => openEntry(f)}
                    >
                      open
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="settings-host-services__hint" style={{ color: DIM }}>
            From <code>tailscale serve status</code> on {hostId}. Open places a page node on the
            canvas.
          </p>
        </div>
      ) : null}
    </div>
  );
}
