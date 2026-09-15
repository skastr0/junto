import {
  edgePortMaskView,
  type CrewPortName,
} from "../../lib/crew-port-mask";
import "./edge-port-mask.css";

export function EdgePortMask({
  compiled,
  allowed,
  verb,
  editable = false,
  onToggle,
}: {
  readonly compiled: ReadonlyArray<string>;
  readonly allowed: ReadonlyArray<string> | undefined;
  readonly verb: string | undefined;
  readonly editable?: boolean;
  readonly onToggle?: (port: CrewPortName) => void;
}) {
  const view = edgePortMaskView(compiled, allowed, verb);
  return (
    <section
      className="edge-port-mask"
      data-testid="edge-port-mask"
      aria-label="Relation ports"
    >
      <span className="edge-port-mask__title">Ports</span>
      {view.chips.length === 0 ? (
        <p className="edge-port-mask__empty">This relation compiles no ports.</p>
      ) : (
        <div className="edge-port-mask__chips">
          {view.chips.map((chip) => {
            const canToggle = editable && chip.attenuable && onToggle !== undefined;
            const label = chip.granted ? chip.label : `${chip.label}, masked`;
            return canToggle ? (
              <button
                key={chip.port}
                type="button"
                className="edge-port-mask__chip"
                data-testid="edge-port-mask-chip"
                data-port={chip.port}
                data-granted={chip.granted ? "true" : "false"}
                data-attenuable="true"
                data-editable="true"
                aria-pressed={chip.granted}
                title={label}
                onClick={() => onToggle(chip.port)}
              >
                {chip.label}
              </button>
            ) : (
              <span
                key={chip.port}
                className="edge-port-mask__chip"
                data-testid="edge-port-mask-chip"
                data-port={chip.port}
                data-granted={chip.granted ? "true" : "false"}
                data-attenuable={chip.attenuable ? "true" : "false"}
                title={label}
              >
                {chip.label}
              </span>
            );
          })}
        </div>
      )}
      <p className="edge-port-mask__hint">
        A mask can only remove compiled ports. Observe is granted unless the
        operator takes it off this wire.
      </p>
    </section>
  );
}
