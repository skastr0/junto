// The GPU cull never leans on an indirect draw's firstInstance (issue 917): a
// non-zero firstInstance needs the optional indirect-first-instance feature,
// and a device without it treats the draw as a no-op, so the GPU arm drew no
// seats. The band's base rides in firstVertex, which every device honours,
// and the vertex stage reads its list entry as vi / 4 + ii.

import { describe, expect, it } from "vitest";
import { QUAD_SHADER } from "../src/window/canvas/engine/renderer";
import { GPU_CULL_SHADER as CULL_SHADER } from "../src/window/canvas/engine/gpu-cull";

describe("the GPU cull's indirect draws", () => {
  it("write the band's base as firstVertex and firstInstance 0", () => {
    expect(CULL_SHADER).toContain("args[b * 4u + 2u] = lo * 4u;");
    expect(CULL_SHADER).toContain("args[b * 4u + 3u] = 0u;");
    expect(CULL_SHADER).not.toContain("args[b * 4u + 3u] = lo;");
  });

  it("are read by a vertex stage that takes the base from the vertex index and the corner from its low bits", () => {
    expect(QUAD_SHADER).toContain("let slot = order[(vi >> 2u) + ii];");
    expect(QUAD_SHADER).toContain("let cornerIndex = vi & 3u;");
    expect(QUAD_SHADER).not.toContain("let slot = order[ii];");
    expect(QUAD_SHADER).not.toContain("f32(vi >> 1u)");
  });
});
