import { MACHINE_COPY_STALL_MS, type MachineDownloadProgress } from "@shared/machine-progress";

/** Byte observations and an injected clock. Authentication controls completion. */
export const makeDownloadProgress = (totalBytes: number, startedAt: number, notify: (event: MachineDownloadProgress) => void) => {
  let downloadedBytes = 0, lastAdvance = startedAt, lastPublished = startedAt, stalled = false, complete = false;
  const publish = (state: MachineDownloadProgress["state"], now: number): void => {
    lastPublished = now;
    try { notify({ event: "machine-download", downloadedBytes, totalBytes, state }); } catch { /* A detached window cannot stop acquisition. */ }
  };
  publish("downloading", startedAt);
  return {
    advance(total: number, now: number): void {
      if (total <= downloadedBytes || complete) return;
      downloadedBytes = Math.min(totalBytes, total); lastAdvance = now;
      const resumed = stalled; stalled = false;
      if (downloadedBytes === totalBytes || resumed || now - lastPublished >= 250) publish("downloading", now);
    },
    check(now: number): void {
      if (!complete && !stalled && downloadedBytes < totalBytes && now - lastAdvance >= MACHINE_COPY_STALL_MS) {
        stalled = true; publish("stalled", now);
      }
    },
    finish(now: number): void {
      if (complete || downloadedBytes !== totalBytes) return;
      complete = true; publish("downloaded", now);
    },
  };
};
