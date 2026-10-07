import type { WorkSinkPage } from "@shared/work-sinks";
import { Button } from "../ui/Button";

export function WorkPageControls({ page, loading, error, loadMore }: {
  readonly page: WorkSinkPage | import("@shared/work-sinks").WorkActorPage;
  readonly loading: boolean;
  readonly error: string;
  readonly loadMore: () => Promise<void>;
}) {
  return <>
    {error ? <span role="status" className="text-label text-crimson-fg">{error}</span> : null}
    {"nextBeforeId" in page && page.nextBeforeId !== undefined ?
      <Button size="xs" variant="subtle" disabled={loading} onClick={() => void loadMore()}>
        {loading ? "Loading…" : `Load older ${page.kind === "task" ? "tasks" : page.kind}`}
      </Button> : null}
  </>;
}
