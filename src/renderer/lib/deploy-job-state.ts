import { useEffect, useState } from "react";
import type { HostDeployJobSnapshot } from "@shared/ipc";
import { getVellumApi } from "./vellum-api";

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
    const api = getVellumApi();
    if (!api?.hostsDeployJobGet || !api.onHostsDeployJobChanged) {
      setJob(null);
      return;
    }

    let cancelled = false;
    void api.hostsDeployJobGet(hostId).then((snapshot) => {
      if (!cancelled) setJob(snapshot);
    }).catch(() => {
      if (!cancelled) setJob(null);
    });

    const unsubscribe = api.onHostsDeployJobChanged((next) => {
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
    const api = getVellumApi();
    if (!api?.hostsDeployJobsList || !api.onHostsDeployJobChanged) {
      setJobs([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      void api.hostsDeployJobsList().then((list) => {
        if (!cancelled) {
          setJobs(list.filter((job) => job.status === "running"));
        }
      }).catch(() => {
        if (!cancelled) setJobs([]);
      });
    };
    refresh();

    const unsubscribe = api.onHostsDeployJobChanged((next) => {
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
