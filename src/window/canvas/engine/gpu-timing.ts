/**
 * GPU pass times (#912): when the device has `timestamp-query`, the frame's
 * render pass writes a timestamp at its start and end, the pair is resolved
 * and copied to a mappable buffer, and the duration is read back when the
 * GPU is done. Readback buffers are pooled: a frame whose every buffer is
 * still in flight goes untimed rather than waiting on the GPU.
 */

/** GPU usage flags, by value (the globals are absent outside a browser). */
const BUFFER = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, QUERY_RESOLVE: 0x200 } as const;
const MAP_READ_MODE = 0x1;
const PAIR_BYTES = 16;

export type GpuPassTimes = {
  /** Whether the device can time passes at all. */
  readonly available: boolean;
  /** Passes timed so far. */
  readonly samples: number;
  /** The last timed pass, and the slowest, in ms of GPU time. */
  readonly lastMs?: number;
  readonly peakMs?: number;
};

export type GpuTimer = {
  /** The pass descriptor's `timestampWrites`, or undefined when untimed this frame. */
  readonly writes: () => GPURenderPassTimestampWrites | undefined;
  /** After the pass ends: resolve and copy the pair, if this frame was timed. */
  readonly resolve: (encoder: GPUCommandEncoder) => void;
  /** After submit: read the pair back when the GPU is done with it. */
  readonly collect: () => void;
  readonly times: () => GpuPassTimes;
  readonly destroy: () => void;
};

export const createGpuTimer = (device: GPUDevice): GpuTimer => {
  const available = device.features?.has("timestamp-query") === true;
  let samples = 0;
  let lastMs: number | undefined;
  let peakMs: number | undefined;
  const times = (): GpuPassTimes => ({
    available,
    samples,
    ...(lastMs === undefined ? {} : { lastMs }),
    ...(peakMs === undefined ? {} : { peakMs }),
  });
  if (!available) {
    return { writes: () => undefined, resolve: () => undefined, collect: () => undefined, times, destroy: () => undefined };
  }
  const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  const resolved = device.createBuffer({ size: PAIR_BYTES, usage: BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC });
  const free: GPUBuffer[] = [];
  const all: GPUBuffer[] = [];
  let current: GPUBuffer | undefined;
  let pending: GPUBuffer | undefined;
  let destroyed = false;

  const take = (): GPUBuffer => {
    const reused = free.pop();
    if (reused !== undefined) return reused;
    const made = device.createBuffer({ size: PAIR_BYTES, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
    all.push(made);
    return made;
  };

  return {
    writes: () => {
      // A pool that only grows while the GPU lags: every frame is timed.
      current = take();
      return { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    },
    resolve: (encoder) => {
      if (current === undefined) return;
      encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, current, 0, PAIR_BYTES);
      pending = current;
      current = undefined;
    },
    collect: () => {
      const buffer = pending;
      pending = undefined;
      if (buffer === undefined) return;
      buffer.mapAsync(MAP_READ_MODE).then(
        () => {
          if (destroyed) return;
          const pair = new BigUint64Array(buffer.getMappedRange());
          const ns = Number(pair[1]! - pair[0]!);
          buffer.unmap();
          free.push(buffer);
          // A zero or wrapped pair is a pass the driver did not time.
          if (!(ns > 0)) return;
          const ms = ns / 1e6;
          samples += 1;
          lastMs = ms;
          peakMs = peakMs === undefined ? ms : Math.max(peakMs, ms);
        },
        () => {
          // Lost device or destroyed buffer: this sample is gone, nothing else.
        },
      );
    },
    times,
    destroy: () => {
      destroyed = true;
      querySet.destroy();
      resolved.destroy();
      for (const buffer of all) buffer.destroy();
    },
  };
};
