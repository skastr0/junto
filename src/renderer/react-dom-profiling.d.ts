/**
 * `react-dom/profiling` ships in the react-dom package (its exports map names
 * it) but @types/react-dom does not declare it. It is the production
 * reconciler with the profiler timers left in — the only build where
 * `<Profiler onRender>` fires outside a development bundle.
 *
 * Ambient on purpose: this file must stay free of top-level import/export so
 * the module declaration is global rather than an augmentation.
 */
declare module "react-dom/profiling" {
  export const createRoot: typeof import("react-dom/client").createRoot;
  export const hydrateRoot: typeof import("react-dom/client").hydrateRoot;
}
