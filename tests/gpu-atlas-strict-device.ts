// A WebGPU device for the atlas tests that keeps every texel it is given and
// rejects what Dawn rejects. The count-only fakes beside it accept any call,
// so a copy inside one texture, a write past an edge or a read of a destroyed
// texture all pass there and corrupt the screen on a real device. Here each
// one is an entry in `errors`, and a command buffer that held an invalid
// command runs none of its commands, as a real queue does.
//
// A texel holds a stamp: the number its source carried. 0 is a texel nothing
// wrote. A test stamps each raster with numbers of its own and then reads
// what a cell's row points at. Only level 0 is kept; a write or a pass on a
// smaller level is checked against that level's size and not stored.
//
// An allocation can run out of memory, as a real one does: the texture comes
// back, holds nothing, and the error scope round its creation answers only
// when the test lets it. Until then the caller cannot know, so writes to such
// a texture are dropped without an error.

const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const RENDER_ATTACHMENT = 0x10;

/** The stamp of a write whose source carried none. */
export const UNSTAMPED = -1;

/** How many writes a texture remembers, for `touchedSince`. */
const WRITE_LOG = 512;

export type StrictTexture = {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
  readonly mipLevelCount: number;
  readonly usage: number;
  readonly isDestroyed: () => boolean;
  /** Made out of memory: it holds nothing, whatever was written to it. */
  readonly isLost: () => boolean;
  /** The stamp at a level 0 texel. */
  readonly at: (x: number, y: number, layer?: number) => number;
  /** A layer's level 0 stamps, row by row; undefined while nothing wrote to it. */
  readonly texels: (layer?: number) => Int32Array | undefined;
  /** Counts the writes to level 0. */
  readonly serial: () => number;
  /** True when a write after `serial` touched the rect, or when the texture no longer remembers that far back. */
  readonly touchedSince: (serial: number, layer: number, x: number, y: number, width: number, height: number) => boolean;
  readonly createView: (descriptor?: GPUTextureViewDescriptor) => StrictView;
  readonly destroy: () => void;
};

type StrictView = { readonly texture: StrictTexture; readonly level: number };

type WriteRecord = { readonly serial: number; readonly layer: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

type TextureState = {
  readonly texture: StrictTexture;
  /** Made out of memory. */
  readonly lost: boolean;
  destroyed: boolean;
  serial: number;
  /** The serial of the newest write the log has forgotten. */
  forgotten: number;
  readonly log: WriteRecord[];
  /** One array per layer, made on the first write to it. */
  readonly layers: Array<Int32Array | undefined>;
};

/** An image the device can copy from: a size, and a stamp per pixel or one for all. */
export type StampSource = {
  readonly width: number;
  readonly height: number;
  readonly stamp?: number;
  readonly stampAt?: (x: number, y: number) => number;
  /** A closed bitmap: copying from it is an error. */
  readonly closed?: boolean;
};

export type StrictDevice = {
  readonly device: GPUDevice;
  /** Every validation error, in order. A correct atlas leaves this empty. */
  readonly errors: ReadonlyArray<string>;
  readonly textures: ReadonlyArray<StrictTexture>;
  /** Texture to texture copies that ran. */
  readonly textureCopies: () => number;
  readonly liveTextures: () => number;
  /** The next texture `matches` picks is made out of memory. */
  readonly failNextTexture: (matches: (width: number, height: number, layers: number) => boolean) => void;
  /** Error scopes that caught an out-of-memory and have not answered yet. */
  readonly unansweredOutOfMemory: () => number;
  /** Let one of them answer. */
  readonly answerOutOfMemory: (index: number) => void;
};

export const strictDevice = (options: { readonly limits?: Partial<GPUSupportedLimits>; readonly mips?: boolean } = {}): StrictDevice => {
  const limits = {
    maxTextureDimension2D: 8192,
    maxTextureArrayLayers: 256,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxSampledTexturesPerShaderStage: 16,
    ...options.limits,
  };
  const errors: string[] = [];
  const states = new Map<StrictTexture, TextureState>();
  const textures: StrictTexture[] = [];
  let textureCopies = 0;
  let nextId = 1;
  type Scope = { readonly filter: string; error: { readonly message: string } | null };
  const scopes: Scope[] = [];
  const unanswered: Array<() => void> = [];
  let failNext: ((width: number, height: number, layers: number) => boolean) | undefined;

  const name = (t: StrictTexture): string => `[Texture ${t.id} ${t.width}x${t.height}x${t.depthOrArrayLayers} ${t.format}]`;

  const stateOf = (texture: unknown, what: string): TextureState | undefined => {
    const state = states.get(texture as StrictTexture);
    if (state === undefined) {
      errors.push(`${what}: not a texture of this device`);
      return undefined;
    }
    return state;
  };

  const layerOf = (state: TextureState, layer: number): Int32Array => {
    let texels = state.layers[layer];
    if (texels === undefined) {
      texels = new Int32Array(state.texture.width * state.texture.height);
      state.layers[layer] = texels;
    }
    return texels;
  };

  const touch = (state: TextureState, layer: number, x: number, y: number, w: number, h: number): void => {
    state.serial += 1;
    state.log.push({ serial: state.serial, layer, x, y, w, h });
    if (state.log.length > WRITE_LOG) state.forgotten = state.log.shift()!.serial;
  };

  /** The reasons a rect of `width` by `height` at `origin` is not a place in `level` of `state`. */
  const rectErrors = (
    state: TextureState,
    origin: { x: number; y: number; z: number },
    width: number,
    height: number,
    what: string,
    level = 0,
  ): string[] => {
    const t = state.texture;
    const out: string[] = [];
    if (state.destroyed) out.push(`${what}: ${name(t)} is destroyed`);
    if (level < 0 || level >= t.mipLevelCount) {
      out.push(`${what}: mip level ${level} is outside ${name(t)} (${t.mipLevelCount} levels)`);
      return out;
    }
    const lw = Math.max(1, t.width >> level);
    const lh = Math.max(1, t.height >> level);
    if (!Number.isInteger(origin.x) || !Number.isInteger(origin.y) || !Number.isInteger(width) || !Number.isInteger(height)) {
      out.push(`${what}: a rect that is not whole texels (${origin.x}, ${origin.y}, ${width}x${height})`);
    }
    if (width <= 0 || height <= 0) out.push(`${what}: an empty rect (${width}x${height})`);
    if (origin.x < 0 || origin.y < 0 || origin.x + width > lw || origin.y + height > lh) {
      out.push(`${what}: rect (${origin.x}, ${origin.y}, ${width}x${height}) is outside level ${level} (${lw}x${lh}) of ${name(t)}`);
    }
    if (origin.z < 0 || origin.z >= t.depthOrArrayLayers) out.push(`${what}: layer ${origin.z} is outside ${name(t)}`);
    return out;
  };

  const originOf = (o: GPUOrigin3D | undefined): { x: number; y: number; z: number } => {
    if (o === undefined) return { x: 0, y: 0, z: 0 };
    if (Symbol.iterator in (o as object)) {
      const [x = 0, y = 0, z = 0] = [...(o as Iterable<number>)];
      return { x, y, z };
    }
    const d = o as GPUOrigin3DDict;
    return { x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 };
  };

  const createTexture = (desc: GPUTextureDescriptor): StrictTexture => {
    const size = desc.size as GPUExtent3DDict;
    const width = size.width;
    const height = size.height ?? 1;
    const layers = size.depthOrArrayLayers ?? 1;
    const mipLevelCount = desc.mipLevelCount ?? 1;
    if (width < 1 || height < 1 || width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) {
      errors.push(`createTexture: ${width}x${height} is outside the device limit ${limits.maxTextureDimension2D}`);
    }
    if (layers < 1 || layers > limits.maxTextureArrayLayers) {
      errors.push(`createTexture: ${layers} layers is outside the device limit ${limits.maxTextureArrayLayers}`);
    }
    if (mipLevelCount > Math.floor(Math.log2(Math.max(width, height))) + 1) {
      errors.push(`createTexture: ${mipLevelCount} levels is more than a ${width}x${height} texture has`);
    }
    const lost = failNext !== undefined && failNext(width, height, layers);
    if (lost) {
      failNext = undefined;
      let scope: Scope | undefined;
      for (let i = scopes.length - 1; i >= 0 && scope === undefined; i -= 1) {
        if (scopes[i]!.filter === "out-of-memory") scope = scopes[i];
      }
      if (scope === undefined) errors.push(`createTexture: ${width}x${height}x${layers} ran out of memory outside any error scope`);
      else scope.error = { message: `out of memory making ${width}x${height}x${layers} ${desc.format}` };
    }
    const state: TextureState = {
      lost,
      destroyed: false,
      serial: 0,
      forgotten: 0,
      log: [],
      layers: [],
      texture: undefined as unknown as StrictTexture,
    };
    const texture: StrictTexture = {
      id: nextId++,
      width,
      height,
      depthOrArrayLayers: layers,
      format: desc.format,
      mipLevelCount,
      usage: desc.usage,
      isDestroyed: () => state.destroyed,
      isLost: () => lost,
      at: (x, y, layer = 0) => state.layers[layer]?.[y * width + x] ?? 0,
      texels: (layer = 0) => state.layers[layer],
      serial: () => state.serial,
      touchedSince: (serial, layer, x, y, w, h) => {
        if (serial >= state.serial) return false;
        if (serial < state.forgotten) return true;
        for (let i = state.log.length - 1; i >= 0; i -= 1) {
          const entry = state.log[i]!;
          if (entry.serial <= serial) break;
          if (entry.layer === layer && entry.x < x + w && x < entry.x + entry.w && entry.y < y + h && y < entry.y + entry.h) return true;
        }
        return false;
      },
      createView: (descriptor) => ({ texture, level: descriptor?.baseMipLevel ?? 0 }),
      destroy: () => {
        state.destroyed = true;
        state.layers.length = 0;
      },
    };
    (state as { texture: StrictTexture }).texture = texture;
    states.set(texture, state);
    textures.push(texture);
    return texture;
  };

  type Command = { readonly run: () => void };
  type CommandBuffer = { readonly valid: boolean; readonly commands: ReadonlyArray<Command> };

  const createCommandEncoder = () => {
    const commands: Command[] = [];
    let valid = true;
    const fail = (reason: string): void => {
      valid = false;
      errors.push(reason);
    };
    return {
      copyTextureToTexture: (source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyTextureInfo, copySize: GPUExtent3DDict): void => {
        const what = "copyTextureToTexture";
        const src = stateOf(source.texture, what);
        const dst = stateOf(destination.texture, what);
        if (src === undefined || dst === undefined) {
          valid = false;
          return;
        }
        const so = originOf(source.origin);
        const dso = originOf(destination.origin);
        const srcLevel = source.mipLevel ?? 0;
        const dstLevel = destination.mipLevel ?? 0;
        const width = copySize.width;
        const height = copySize.height ?? 1;
        const layers = copySize.depthOrArrayLayers ?? 1;
        const found = [...rectErrors(src, so, width, height, what, srcLevel), ...rectErrors(dst, dso, width, height, what, dstLevel)];
        if ((src.texture.usage & COPY_SRC) === 0) found.push(`${what}: ${name(src.texture)} has no COPY_SRC usage`);
        if ((dst.texture.usage & COPY_DST) === 0) found.push(`${what}: ${name(dst.texture)} has no COPY_DST usage`);
        if (src.texture.format !== dst.texture.format) found.push(`${what}: formats differ (${src.texture.format}, ${dst.texture.format})`);
        // Dawn: a copy inside one texture is invalid when the two layer ranges
        // of one mip level overlap, whatever the rects are.
        if (src === dst && srcLevel === dstLevel && so.z < dso.z + layers && dso.z < so.z + layers) {
          found.push(
            `Copy source and destination are overlapping layer ranges ([${so.z}, ${so.z + layers}) and [${dso.z}, ${dso.z + layers})) of ${name(src.texture)} mip level ${srcLevel}`,
          );
        }
        if (found.length > 0) {
          for (const reason of found) fail(reason);
          return;
        }
        commands.push({
          run: () => {
            if (src.destroyed || dst.destroyed) {
              errors.push(`${what}: a destroyed texture in a submitted copy`);
              return;
            }
            textureCopies += 1;
            if (srcLevel !== 0 || dstLevel !== 0) return;
            const from = layerOf(src, so.z);
            const to = layerOf(dst, dso.z);
            for (let row = 0; row < height; row += 1) {
              const s = (so.y + row) * src.texture.width + so.x;
              to.set(from.subarray(s, s + width), (dso.y + row) * dst.texture.width + dso.x);
            }
            touch(dst, dso.z, dso.x, dso.y, width, height);
          },
        });
      },
      beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
        let target: StrictView | undefined;
        for (const attachment of descriptor.colorAttachments) {
          const view = attachment?.view as unknown as StrictView | undefined;
          if (view === undefined) continue;
          target = view;
          const state = states.get(view.texture);
          if (state === undefined || state.destroyed) fail("beginRenderPass: the attachment's texture is destroyed");
          else if ((view.texture.usage & RENDER_ATTACHMENT) === 0) fail(`beginRenderPass: ${name(view.texture)} has no RENDER_ATTACHMENT usage`);
        }
        return {
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setScissorRect: (x: number, y: number, width: number, height: number) => {
            if (target === undefined) return;
            const w = Math.max(1, target.texture.width >> target.level);
            const h = Math.max(1, target.texture.height >> target.level);
            if (x < 0 || y < 0 || x + width > w || y + height > h) {
              fail(`setScissorRect: (${x}, ${y}, ${width}x${height}) is outside the ${w}x${h} attachment`);
            }
          },
          draw: () => undefined,
          end: () => undefined,
        };
      },
      finish: (): CommandBuffer => ({ valid, commands }),
    };
  };

  /** Write `width` by `height` stamps read from `stampAt` into a texture, or record why not. */
  const write = (
    what: string,
    destination: GPUTexelCopyTextureInfo,
    width: number,
    height: number,
    usage: number,
    stampAt: (x: number, y: number) => number,
    extra: ReadonlyArray<string> = [],
  ): void => {
    const state = stateOf(destination.texture, what);
    if (state === undefined) return;
    // Nobody knows yet that this texture is not there.
    if (state.lost && !state.destroyed) return;
    const origin = originOf(destination.origin);
    const level = destination.mipLevel ?? 0;
    const found = [...extra, ...rectErrors(state, origin, width, height, what, level)];
    if ((state.texture.usage & usage) !== usage) found.push(`${what}: ${name(state.texture)} lacks usage 0x${usage.toString(16)}`);
    if (found.length > 0) {
      errors.push(...found);
      return;
    }
    if (level !== 0) return;
    const texels = layerOf(state, origin.z);
    for (let row = 0; row < height; row += 1) {
      const base = (origin.y + row) * state.texture.width + origin.x;
      for (let col = 0; col < width; col += 1) texels[base + col] = stampAt(col, row);
    }
    touch(state, origin.z, origin.x, origin.y, width, height);
  };

  const device = {
    limits,
    createTexture,
    createSampler: () => ({}),
    createCommandEncoder,
    pushErrorScope: (filter: string) => {
      scopes.push({ filter, error: null });
    },
    popErrorScope: (): Promise<{ readonly message: string } | null> => {
      const scope = scopes.pop();
      if (scope === undefined) {
        errors.push("popErrorScope: no error scope is open");
        return Promise.resolve(null);
      }
      if (scope.error === null) return Promise.resolve(null);
      const { error } = scope;
      return new Promise((resolve) => unanswered.push(() => resolve(error)));
    },
    ...(options.mips === false
      ? {}
      : {
          createShaderModule: () => ({}),
          createBindGroupLayout: () => ({}),
          createPipelineLayout: () => ({}),
          createRenderPipeline: () => ({}),
          createBindGroup: () => ({}),
        }),
    queue: {
      submit: (buffers: ReadonlyArray<CommandBuffer>): void => {
        // One invalid command buffer and the submit does nothing at all.
        if (buffers.some((b) => !b.valid)) {
          errors.push("[Invalid CommandBuffer] is invalid due to a previous error. - While calling [Queue].Submit");
          return;
        }
        for (const buffer of buffers) for (const command of buffer.commands) command.run();
      },
      writeBuffer: () => undefined,
      copyExternalImageToTexture: (
        source: { readonly source: StampSource; readonly origin?: { readonly x?: number; readonly y?: number } },
        destination: GPUTexelCopyTextureInfo,
        size: { readonly width: number; readonly height?: number },
      ): void => {
        const what = "copyExternalImageToTexture";
        const image = source.source;
        const sx = source.origin?.x ?? 0;
        const sy = source.origin?.y ?? 0;
        const height = size.height ?? 1;
        const extra: string[] = [];
        if (image.closed === true) extra.push(`${what}: the source image is closed`);
        if (sx < 0 || sy < 0 || sx + size.width > image.width || sy + height > image.height) {
          extra.push(`${what}: source rect (${sx}, ${sy}, ${size.width}x${height}) is outside the ${image.width}x${image.height} image`);
        }
        const stampAt =
          image.stampAt !== undefined
            ? (x: number, y: number) => image.stampAt!(sx + x, sy + y)
            : () => image.stamp ?? UNSTAMPED;
        write(what, destination, size.width, height, COPY_DST | RENDER_ATTACHMENT, stampAt, extra);
      },
      writeTexture: (
        destination: GPUTexelCopyTextureInfo,
        data: Uint8Array,
        layout: { readonly offset?: number; readonly bytesPerRow?: number; readonly rowsPerImage?: number },
        size: { readonly width: number; readonly height?: number },
      ): void => {
        const what = "writeTexture";
        const height = size.height ?? 1;
        const offset = layout.offset ?? 0;
        const state = states.get(destination.texture as unknown as StrictTexture);
        // One stamp per texel: its first byte. An rgba texel is four bytes.
        const bytesPerTexel = state !== undefined && state.texture.format === "rgba8unorm" ? 4 : 1;
        const rowBytes = size.width * bytesPerTexel;
        const bytesPerRow = layout.bytesPerRow ?? rowBytes;
        const extra: string[] = [];
        if (bytesPerRow < rowBytes) extra.push(`${what}: bytesPerRow ${bytesPerRow} is less than a row of ${size.width} texels (${rowBytes} bytes)`);
        if (offset + bytesPerRow * (height - 1) + rowBytes > data.length) {
          extra.push(`${what}: ${data.length} bytes is too few for ${size.width}x${height} at offset ${offset}, ${bytesPerRow} per row`);
        }
        write(what, destination, size.width, height, COPY_DST, (x, y) => data[offset + y * bytesPerRow + x * bytesPerTexel] ?? 0, extra);
      },
    },
  } as unknown as GPUDevice;

  return {
    device,
    errors,
    textures,
    textureCopies: () => textureCopies,
    liveTextures: () => textures.filter((t) => !t.isDestroyed()).length,
    failNextTexture: (matches) => {
      failNext = matches;
    },
    unansweredOutOfMemory: () => unanswered.length,
    answerOutOfMemory: (index) => {
      const [answer] = unanswered.splice(index, 1);
      answer?.();
    },
  };
};
