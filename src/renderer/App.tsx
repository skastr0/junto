import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import {
  Activity,
  Box,
  Braces,
  FolderOpen,
  GitBranch,
  Network,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { motion } from "motion/react";
import type { ServiceCheck } from "@shared/contracts";
import { StatusPill } from "./components/StatusPill";
import { appState$ } from "./lib/state";

const runAction = async <T,>(action: () => Promise<T>, onDone: (value: T) => void) => {
  appState$.busy.set(true);
  appState$.error.set("");
  try {
    onDone(await action());
  } catch (error) {
    appState$.error.set(error instanceof Error ? error.message : String(error));
  } finally {
    appState$.busy.set(false);
  }
};

const requireChassisApi = () => {
  if (!window.chassis) {
    throw new Error("Electron preload bridge is not available.");
  }

  return window.chassis;
};

const serviceIcon: Record<string, typeof Activity> = {
  store: Box,
  folder: FolderOpen,
  prism: Braces,
  codex: Terminal,
  "codex-app-server": Network,
  "prism-compile": GitBranch,
};

function ServiceCard({ service }: { readonly service: ServiceCheck }) {
  const Icon = serviceIcon[service.id] ?? Activity;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="min-h-36 rounded-lg border border-white/10 bg-white/[0.045] p-4 shadow-2xl shadow-black/20"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md border border-cyan-200/20 bg-cyan-300/10 text-cyan-100">
            <Icon size={18} aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-50">{service.label}</h2>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{service.detail}</p>
          </div>
        </div>
        <StatusPill status={service.status} />
      </div>
      {service.metadata ? (
        <dl className="mt-4 grid gap-2 text-xs text-slate-400">
          {Object.entries(service.metadata).map(([key, value]) => (
            <div key={key} className="grid grid-cols-[9rem_1fr] gap-2">
              <dt className="truncate text-slate-500">{key}</dt>
              <dd className="truncate font-mono text-slate-300">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </motion.article>
  );
}

function FolderPanel() {
  const root = use$(appState$.folderRoot);
  const entries = use$(appState$.folderEntries);

  return (
    <section className="rounded-lg border border-white/10 bg-slate-950/70">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Folder Probe</h2>
          <p className="mt-1 max-w-3xl truncate font-mono text-xs text-slate-500">
            {root || "No folder selected"}
          </p>
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-md border border-cyan-300/25 bg-cyan-300/10 px-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-300/15"
          onClick={() =>
            void runAction(() => requireChassisApi().selectFolder(), (snapshot) => {
              if (!snapshot) return;
              appState$.folderRoot.set(snapshot.root);
              appState$.folderEntries.set(snapshot.entries);
            })
          }
        >
          <FolderOpen size={16} aria-hidden />
          Open
        </button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {entries.length === 0 ? (
          <div className="px-2 py-10 text-center text-sm text-slate-500">
            Select a local folder to verify the renderer to main process bridge.
          </div>
        ) : (
          <div className="grid gap-1">
            {entries.slice(0, 80).map((entry) => (
              <button
                key={entry.path}
                className="grid grid-cols-[1fr_6rem_9rem] items-center gap-3 rounded-md px-3 py-2 text-left text-xs text-slate-300 transition hover:bg-white/[0.06]"
                onClick={() => {
                  if (entry.kind !== "directory") return;
                  void runAction(() => requireChassisApi().readDirectory(entry.path), (nextEntries) => {
                    appState$.folderRoot.set(entry.path);
                    appState$.folderEntries.set(nextEntries);
                  });
                }}
              >
                <span className="truncate font-mono">{entry.name}</span>
                <span className="text-slate-500">{entry.kind}</span>
                <span className="text-right text-slate-500">{Math.round(entry.size / 1024)} KB</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function App() {
  const doctor = use$(appState$.doctor);
  const busy = use$(appState$.busy);
  const error = use$(appState$.error);
  const codexProbe = use$(appState$.codexProbe);
  const prismDryRun = use$(appState$.prismDryRun);

  useEffect(() => {
    if (!window.chassis) {
      appState$.error.set("Electron preload bridge is not available.");
      return;
    }

    void runAction(() => requireChassisApi().doctor(), (report) => appState$.doctor.set(report));
  }, []);

  const services = [
    ...(doctor?.services ?? []),
    ...(codexProbe ? [codexProbe] : []),
    ...(prismDryRun ? [prismDryRun] : []),
  ];

  return (
    <main className="min-h-screen bg-[#080a0f] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-5 px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-200/70">
              AI desktop chassis
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-white">
              Local station control surface
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[0.06] px-3 text-sm font-medium text-slate-100 transition hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() =>
                void runAction(() => requireChassisApi().doctor(), (report) => appState$.doctor.set(report))
              }
            >
              <RefreshCw className={busy ? "animate-spin" : ""} size={16} aria-hidden />
              Refresh
            </button>
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-cyan-300/25 bg-cyan-300/10 px-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-300/15 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() =>
                void runAction(() => requireChassisApi().probeCodex(), (check) => appState$.codexProbe.set(check))
              }
            >
              <Terminal size={16} aria-hidden />
              Probe Codex
            </button>
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-emerald-300/25 bg-emerald-300/10 px-3 text-sm font-medium text-emerald-100 transition hover:bg-emerald-300/15 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() =>
                void runAction(() => requireChassisApi().prismDryRun(), (check) =>
                  appState$.prismDryRun.set(check),
                )
              }
            >
              <Braces size={16} aria-hidden />
              Prism Dry Run
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-4">
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">User data</p>
            <p className="mt-3 truncate font-mono text-xs text-slate-300">
              {doctor?.station.userDataPath ?? "pending"}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Station plugin</p>
            <p className="mt-3 truncate font-mono text-xs text-slate-300">
              {doctor?.station.stationPluginPath ?? "pending"}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Prism root</p>
            <p className="mt-3 truncate font-mono text-xs text-slate-300">
              {doctor?.station.prismRoot ?? "pending"}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Checked</p>
            <p className="mt-3 truncate font-mono text-xs text-slate-300">
              {doctor?.checkedAt ?? "pending"}
            </p>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {services.map((service) => (
            <ServiceCard key={`${service.id}-${service.detail}`} service={service} />
          ))}
        </section>

        <FolderPanel />
      </div>
    </main>
  );
}
