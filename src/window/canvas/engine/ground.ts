/**
 * The ground under a damage rectangle (issue 915). A frame only motion drives
 * loads the kept frame and redraws the pixels its movers reach. Translucent
 * quads blend over what is under them, so each rectangle must first be the
 * board's ground again, exactly as a cleared frame starts; drawn over last
 * frame's pixels instead, every translucent fill stacks once per frame until
 * it is solid. A render pass clears only its whole attachment, so the ground
 * is one triangle over the pass's scissor, blending off, in the clear colour.
 */

const GROUND_SHADER = /* wgsl */ `
struct Ground { colour: vec4f };
@group(0) @binding(0) var<uniform> ground: Ground;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return ground.colour;
}
`;

/** WebGPU's buffer-usage and shader-stage flags, by the numbers the spec gives them. */
const BUFFER = { UNIFORM: 0x40, COPY_DST: 0x08 } as const;
const STAGE = { FRAGMENT: 2 } as const;

export type GroundColour = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };

export const createGroundFill = () => {
  let held:
    | {
        readonly device: GPUDevice;
        readonly format: GPUTextureFormat;
        readonly pipeline: GPURenderPipeline;
        readonly uniform: GPUBuffer;
        readonly bind: GPUBindGroup;
        colour: GroundColour | undefined;
      }
    | undefined;
  const values = new Float32Array(4);

  const resources = (device: GPUDevice, format: GPUTextureFormat) => {
    if (held !== undefined && held.device === device && held.format === format) return held;
    held?.uniform.destroy();
    const module = device.createShaderModule({ label: "ground", code: GROUND_SHADER });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: STAGE.FRAGMENT, buffer: { type: "uniform" } }],
    });
    const pipeline = device.createRenderPipeline({
      label: "ground",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vs" },
      // No blend: the ground replaces what the kept frame held, as a clear does.
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const uniform = device.createBuffer({ label: "ground colour", size: values.byteLength, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
    const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
    held = { device, format, pipeline, uniform, bind, colour: undefined };
    return held;
  };

  return {
    /** Before a pass that fills: write the colour when it changed. */
    prepare: (device: GPUDevice, format: GPUTextureFormat, colour: GroundColour): void => {
      const r = resources(device, format);
      if (r.colour !== undefined && r.colour.r === colour.r && r.colour.g === colour.g && r.colour.b === colour.b && r.colour.a === colour.a) return;
      values[0] = colour.r;
      values[1] = colour.g;
      values[2] = colour.b;
      values[3] = colour.a;
      device.queue.writeBuffer(r.uniform, 0, values);
      r.colour = colour;
    },
    /** Fill the pass's current scissor with the ground. */
    encode: (pass: GPURenderPassEncoder): void => {
      if (held === undefined) return;
      pass.setPipeline(held.pipeline);
      pass.setBindGroup(0, held.bind);
      pass.draw(3, 1, 0, 0);
    },
    dispose: (): void => {
      held?.uniform.destroy();
      held = undefined;
    },
  };
};
