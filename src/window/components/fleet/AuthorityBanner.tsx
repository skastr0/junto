/**
 * The authority banner over the canvas (0.11/06 F5, look: 06-fleet-state-look).
 *
 * A state, not a message: no close. The words all come from
 * @shared/authority. The list is a row of chips in the operator's order, each
 * a button that opens the Machines window on that machine, where the fix is.
 * The live region sits on the title and the state sentence only, so a refresh
 * that changes a time does not read the whole banner out again.
 */
import { authorityBannerOf, authorityChipWords, authorityMachineSentence, type AuthorityView } from "@shared/authority";
import { authorityWhen, useAuthorityView } from "../../lib/authority";
import { openMachines } from "../../lib/machines-window";

const AuthorityChips = ({ view }: { view: AuthorityView }) => {
  const sentence = authorityMachineSentence(view, authorityWhen);
  return (
    <div className="authority-banner__chips" role="group" aria-label={sentence}>
      {view.list.map((machine, at) => {
        const words = authorityChipWords(view, machine, authorityWhen);
        return (
          <button
            key={machine.installationId}
            type="button"
            className="authority-banner__chip"
            data-role={machine.isAuthority ? "ruling" : machine.reach}
            aria-label={`${machine.label}, ${at + 1}, ${words}`}
            onClick={() => openMachines(machine.name)}
          >
            <span className="authority-banner__position" aria-hidden="true">{at + 1}</span>
            <span className="authority-banner__label">{machine.label}</span>
            <span className="authority-banner__words">{words}</span>
          </button>
        );
      })}
    </div>
  );
};

export const AuthorityBanner = ({ canvasName }: { canvasName: string | undefined }) => {
  const view = useAuthorityView(canvasName);
  if (view === undefined) return null;
  const banner = authorityBannerOf(view, authorityWhen);
  if (banner === undefined) return null;
  return (
    <div className={`authority-banner authority-banner--${banner.kind}`} data-kind={banner.kind}>
      <div className="authority-banner__heading" role="status" aria-live="polite">
        <span className="authority-banner__title">{banner.title}</span>
        <span className="authority-banner__states sr-only">{authorityMachineSentence(view, authorityWhen)}</span>
      </div>
      <AuthorityChips view={view} />
      {banner.lines.map((line) => (
        <p key={line} className="authority-banner__line">{line}</p>
      ))}
    </div>
  );
};
