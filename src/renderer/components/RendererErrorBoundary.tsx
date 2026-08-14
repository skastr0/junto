import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Eyebrow } from "./ui";

export function RendererCrashFallback({
  title,
  detail,
  onReload,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly onReload: () => void;
}) {
  return (
    <div
      role="alert"
      className="pointer-events-auto mx-auto my-8 grid max-w-md gap-3 rounded-[5px] border border-stroke bg-raise px-6 py-5 text-center"
    >
      <Eyebrow tone="amber">Vellum Command</Eyebrow>
      <p className="font-display text-[18px] text-ink">{title}</p>
      <p className="max-w-md text-[12px] text-dim">
        The station is still running. This view hit a render error and was
        taken down so it would not stay blank.
      </p>
      {detail ? (
        <p className="max-w-md truncate font-mono text-[11px] text-faint" title={detail}>
          {detail}
        </p>
      ) : null}
      <div>
        <Button size="sm" variant="primary" onClick={onReload}>
          Reload this view
        </Button>
      </div>
    </div>
  );
}

type Props = {
  readonly title: string;
  readonly children: ReactNode;
  readonly onReset?: () => void;
};

type State = {
  readonly error: Error | undefined;
  readonly generation: number;
};

/**
 * Catches a render/layout throw so one surface cannot unmount the whole
 * Command Center. There is no product ErrorBoundary above this.
 */
export class RendererErrorBoundary extends Component<Props, State> {
  public state: State = { error: undefined, generation: 0 };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] view crashed", this.props.title, error, info.componentStack);
  }

  private readonly reload = (): void => {
    this.props.onReset?.();
    this.setState((prev) => ({
      error: undefined,
      generation: prev.generation + 1,
    }));
  };

  public render(): ReactNode {
    if (this.state.error !== undefined) {
      return (
        <RendererCrashFallback
          title={this.props.title}
          detail={this.state.error.message}
          onReload={this.reload}
        />
      );
    }
    return (
      <div key={this.state.generation} className="contents">
        {this.props.children}
      </div>
    );
  }
}
