import { MACHINE_COPY_STALL_MS, type MachineCopyProgress } from "@shared/machine-progress";

/** A single copy's clock and byte observations. No timer or durable state. */
export const makeCopyProgress = (totalBytes: number, startedAt: number, notify: (event: MachineCopyProgress) => void) => {
  let copiedBytes = 0, lastAdvance = startedAt, lastPublished = startedAt, stalled = false;
  const publish = (state: MachineCopyProgress["state"], now: number) => {
    lastPublished = now;
    try { notify({ event: "machine-copy", copiedBytes, totalBytes, state }); } catch { /* A detached observer cannot stop a copy. */ }
  };
  publish("copying", startedAt);
  return {
    advance(bytes: number, now: number): void {
      if (bytes <= 0 || copiedBytes === totalBytes) return;
      copiedBytes = Math.min(totalBytes, copiedBytes + bytes);
      lastAdvance = now;
      const resumed = stalled;
      stalled = false;
      if (copiedBytes === totalBytes || resumed || now - lastPublished >= 250) publish(copiedBytes === totalBytes ? "copied" : "copying", now);
    },
    check(now: number): void {
      if (!stalled && copiedBytes < totalBytes && now - lastAdvance >= MACHINE_COPY_STALL_MS) {
        stalled = true;
        publish("stalled", now);
      }
    },
  };
};
