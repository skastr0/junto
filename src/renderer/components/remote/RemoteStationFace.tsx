import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { PRODUCT_NAME } from "@shared/product-name";
import { state$ } from "../../lib/state";
import {
  loadRemoteStationFaceStats,
  pickRemoteStationFaceApi,
  type RemoteStationFaceStats,
} from "../../lib/remote-station-face";

const TITLE = `${PRODUCT_NAME} Remote`;

const Row = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) => (
  <div className="flex gap-3 border-b border-stroke py-1.5">
    <dt className="w-36 shrink-0 text-dim">{label}</dt>
    <dd className="min-w-0 break-all text-ink">{value}</dd>
  </div>
);

export function RemoteStationFaceView({
  stats,
}: {
  readonly stats: RemoteStationFaceStats;
}) {
  return (
    <div
      className="flex h-screen w-screen flex-col overflow-auto bg-ground font-mono text-[12px] text-ink"
      data-remote-station-face=""
    >
      <header className="station-bar shrink-0">
        <h1 className="font-display text-[14px] text-ink">{TITLE}</h1>
      </header>
      <main className="flex flex-col gap-6 p-6">
        <dl>
          <Row label="Role" value={stats.role} />
          <Row label="Host" value={stats.hostId} />
          {stats.installationId !== undefined ? (
            <Row label="Installation" value={stats.installationId} />
          ) : null}
          {stats.appVersion !== undefined ? (
            <Row label="Version" value={stats.appVersion} />
          ) : null}
          {stats.projection !== undefined ? (
            <Row label="Projection" value={stats.projection} />
          ) : null}
          {stats.lastCheckIn !== undefined ? (
            <Row label="Last check-in" value={stats.lastCheckIn} />
          ) : null}
          {stats.terminalCount !== undefined ? (
            <Row
              label="Terminals"
              value={`${String(stats.terminalCount)} total, ${String(stats.runningTerminalCount ?? 0)} running`}
            />
          ) : null}
          {stats.compatibility !== undefined ? (
            <Row
              label="Compatibility"
              value={`${stats.compatibility.headline} - ${stats.compatibility.detail}`}
            />
          ) : null}
        </dl>
        {stats.services !== undefined ? (
          <section>
            <h2 className="mb-2 text-[10px] uppercase tracking-[0.14em] text-dim">
              Doctor
            </h2>
            <ul className="flex flex-col gap-2">
              {stats.services.map((service) => (
                <li
                  key={service.label}
                  className="border border-stroke px-3 py-2"
                >
                  <div className="flex gap-2 text-ink">
                    <span>{service.label}</span>
                    <span className="text-dim">{service.status}</span>
                  </div>
                  <p className="mt-1 break-all text-dim">{service.detail}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export function RemoteStationFace() {
  const role = use$(state$.settings.station.role);
  const hostId = use$(state$.settings.station.hostId);
  const [stats, setStats] = useState<RemoteStationFaceStats>({
    role,
    hostId,
  });

  useEffect(() => {
    let cancelled = false;
    const api = pickRemoteStationFaceApi(
      window.junto,
      window.chassis,
    );
    void loadRemoteStationFaceStats({ role, hostId }, api).then((next) => {
      if (!cancelled) setStats(next);
    });
    return () => {
      cancelled = true;
    };
  }, [role, hostId]);

  return <RemoteStationFaceView stats={stats} />;
}
