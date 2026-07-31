import { ArrowUpRight } from "lucide-react";
import type { LinuxHostCapabilityObservation } from "@shared/linux-host-capabilities";
import { presentLinuxHostCapabilities } from "../lib/linux-host-capability-presentation";

export function LinuxHostCapabilities({
  observation,
  compact = false,
}: {
  readonly observation: LinuxHostCapabilityObservation;
  readonly compact?: boolean;
}) {
  const presentation = presentLinuxHostCapabilities(observation);
  return (
    <div
      className={`linux-host-capabilities${
        compact ? " linux-host-capabilities--compact" : ""
      }`}
      aria-label="Linux host capabilities"
    >
      <div className="linux-host-capabilities__head">
        <span>Host capability assessment</span>
        <strong data-core-status={presentation.coreStatus}>
          {presentation.summary}
        </strong>
      </div>
      <ul className="linux-host-capabilities__list">
        {presentation.capabilities.map((capability) => (
          <li
            key={capability.id}
            className="linux-host-capability"
            data-capability={capability.id}
            data-status={capability.status}
          >
            <div className="linux-host-capability__line">
              <span className="linux-host-capability__label">
                {capability.label}
              </span>
              <span className="linux-host-capability__status">
                {capability.statusLabel}
              </span>
            </div>
            <p className="linux-host-capability__summary">
              {capability.summary}
            </p>
            {capability.consequence && capability.remediation ? (
              <div className="linux-host-capability__finding">
                <p>{capability.consequence}</p>
                <p>{capability.remediation.summary}</p>
                <a
                  href={capability.remediation.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-doc-reference={capability.remediation.reference}
                  aria-label={`${capability.label}: review Linux host preparation`}
                >
                  {capability.remediation.authority === "administrator"
                    ? "Administrator preparation"
                    : "Operator preparation"}
                  <ArrowUpRight size={11} aria-hidden="true" />
                </a>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
