import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

/**
 * A surface whose code stays out of the window's first load: it loads when
 * one first draws, or once the window is idle after loading, whichever comes
 * first. Until then `fallback` holds its place. Once loaded, a surface draws
 * at once with no fallback, so a host that hands the keyboard to it as it
 * opens finds it there.
 */
export const lazySurface = <P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: (props: P) => ReactNode,
): ComponentType<P> => {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const start = (): Promise<ComponentType<P>> =>
    (loading ??= load().then((component) => (loaded = component)));
  const Pending = lazy(() => start().then((component) => ({ default: component })));
  starts.add(start);
  whenIdleAfterLoad(() => void start().catch(() => undefined));

  return function LazySurface(props: P) {
    // Fixed per instance: one that opened on the fallback keeps that path, so
    // the load never swaps its tree and remounts what it holds.
    const [Loaded] = useState(() => loaded);
    if (Loaded !== undefined) return <Loaded {...props} />;
    return (
      <Suspense fallback={fallback(props)}>
        <Pending {...props} />
      </Suspense>
    );
  };
};

const starts = new Set<() => Promise<unknown>>();

/**
 * Loads every surface defined so far. Each one then draws at once, with no
 * fallback, however long its load took. A test awaits this at the top of its
 * file, where no test timeout runs.
 */
export const loadLazySurfaces = async (): Promise<void> => {
  await Promise.all([...starts].map((start) => start()));
};

/** Runs once the page has loaded and the main thread has a spare moment. */
const whenIdleAfterLoad = (run: () => void): void => {
  if (typeof window === "undefined" || typeof window.requestIdleCallback !== "function") return;
  const idle = (): void => void window.requestIdleCallback(run, { timeout: 5_000 });
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
};
