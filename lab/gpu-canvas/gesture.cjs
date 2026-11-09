// The one gesture script both arms replay: the GPU canvas lab and the product's
// own canvas (e2e/scenarios/zz-zoom-smooth.spec.ts). Wheel events at trackpad
// rate; with ctrl held a wheel event is a pinch, and one event scales the
// zoom by 2 ^ (-deltaY * 0.02), which is React Flow's own formula.
//
// Run directly to print the script as JSON.

function build(hz = 120) {
  const dt = 1000 / hz;
  const steps = [];
  const gestures = [];
  let t = 1500;
  const run = (kind, count, dx, dy, ctrl) => {
    const start = t;
    for (let i = 0; i < count; i++) {
      steps.push({ at: t, dx, dy, ctrl });
      t += dt;
    }
    gestures.push({ kind, start, end: t - dt });
    t += 450;
  };
  // From the whole board (0.15) to reading distance (1.0) and back: every
  // detail level is crossed in each direction.
  for (let rep = 0; rep < 4; rep++) {
    run("zoom-in", 92, 0, -1.5, true);
    run("zoom-out", 92, 0, 1.5, true);
  }
  // Into the middle level (about 0.52), then small zooms that cross nothing.
  run("zoom-in", 60, 0, -1.5, true);
  for (let rep = 0; rep < 3; rep++) {
    run("zoom-in-level", 40, 0, -0.25, true);
    run("zoom-out-level", 40, 0, 0.25, true);
  }
  for (let rep = 0; rep < 3; rep++) {
    run("pan", 72, 14, 6, false);
    run("pan", 72, -14, -6, false);
  }
  return { hz, steps, gestures, end: t + 1000 };
}

module.exports = { build };

if (require.main === module) process.stdout.write(JSON.stringify(build(Number(process.argv[2] ?? 120))));
