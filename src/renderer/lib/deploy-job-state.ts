import { useEffect, useState } from "react";
import type { HostDeployJobSnapshot } from "@shared/ipc";
import { getJuntoApi } from "./junto-api";

/**
 * Mirror of the main-owned deploy job for a host.
 * Survives panel remount: re-fetches snapshot + subscribes to live updates.
 */
export const useHostDeployJob = (
  hostId: string | undefined,
): HostDeployJobSnapshot | null => {
  const [job, setJob] = useState<HostDeployJobSnapshot | null>(null);

  useEffect(() => {
    if (hostId === undefined || hostId.length === 0) {
      setJob(null);
      return;
    }
    const api = getJuntoApi();
    const getJob = api?.hostsDeployJobGet;
    const onChanged = api?.onHostsDeployJobChanged;
    if (!getJob || !onChanged) {
      setJob(null);
      return;
    }

    let cancelled = false;
    void getJob(hostId).then((snapshot) => {
      if (!cancelled) setJob(snapshot);
    }).catch(() => {
      if (!cancelled) setJob(null);
    });

    const unsubscribe = onChanged((next) => {
      if (next.hostId === hostId) setJob(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hostId]);

  return job;
};

/** Any active (running) deploy across the fleet — for a global strip. */
export const useRunningDeployJobs = (): ReadonlyArray<HostDeployJobSnapshot> => {
  const [jobs, setJobs] = useState<ReadonlyArray<HostDeployJobSnapshot>>([]);

  useEffect(() => {
    const api = getJuntoApi();
    const listJobs = api?.hostsDeployJobsList;
    const onChanged = api?.onHostsDeployJobChanged;
    if (!listJobs || !onChanged) {
      setJobs([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      void listJobs().then((list) => {
        if (!cancelled) {
          setJobs(list.filter((job) => job.status === "running"));
        }
      }).catch(() => {
        if (!cancelled) setJobs([]);
      });
    };
    refresh();

    const unsubscribe = onChanged((next) => {
      setJobs((prev) => {
        const without = prev.filter((job) => job.hostId !== next.hostId);
        if (next.status === "running") return [...without, next];
        return without;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return jobs;
};
