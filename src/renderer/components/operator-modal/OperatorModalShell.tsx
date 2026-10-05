import { useEffect, useRef, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { claimFocus } from "../../lib/focus-ownership";
import { useModalLayer } from "../../lib/modal-stack";
import {
  closeOperatorModal,
  isOperatorModalOpen,
  measureOperatorModalPainted,
  operatorModalOpener,
  type OperatorModalId,
} from "../../lib/operator-modal";
import { IconButton, OverlayHeader } from "../ui";
import "./operator-modal.css";

/**
 * The one shell for operator modals (search, the needs-you feed): backdrop,
 * frame, focus trap, focus restore, and Escape that closes only this layer.
 * A body renders its content inside it and owns nothing else about the
 * modal.
 *
 * Focus: a body that has a field claims it itself; otherwise the frame takes
 * the keyboard so the body's keys work at once. Closing returns focus to
 * where it was before the operator layer opened, a terminal included.
 */
export function OperatorModalShell({
  id,
  label,
  title,
  status,
  headerProps,
  width,
  fill = false,
  panelClassName,
  onEscape,
  onKeyDown,
  children,
}: {
  readonly id: OperatorModalId;
  /** Accessible name of the dialog. */
  readonly label: string;
  /** With a title the shell renders the header and its close button. */
  readonly title?: ReactNode;
  readonly status?: ReactNode;
  readonly headerProps?: Omit<HTMLAttributes<HTMLElement>, "title">;
  /** Frame width in px; the window caps it. */
  readonly width?: number;
  /** Take the full available height instead of the content's. */
  readonly fill?: boolean;
  readonly panelClassName?: string;
  /**
   * First say on Escape: return true when the body used it (closed a reply
   * draft), and the modal stays open.
   */
  readonly onEscape?: () => boolean;
  /** Body keys, heard wherever focus sits inside the modal. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const close = (): void => closeOperatorModal(id);

  const layer = useModalLayer({
    layer: "operator",
    containerRef: frameRef,
    returnFocusTo: operatorModalOpener(),
    // A swap: the next operator modal is already open and takes the keyboard.
    keepFocusOnClose: isOperatorModalOpen,
    onEscape: () => {
      if (onEscapeRef.current?.() !== true) closeOperatorModal(id);
    },
    onKeyDown,
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (frame && !frame.contains(document.activeElement)) {
      claimFocus(frame, "open", { preventScroll: true });
    }
    // The frame after this one is the first the operator can see.
    const raf = requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => measureOperatorModalPainted(id);
      channel.port2.postMessage(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [id]);

  return createPortal(
    <div
      className="operator-modal"
      data-layer="operator"
      data-operator-modal={id}
      data-testid="operator-modal"
      onKeyDown={layer.onKeyDown}
    >
      <button
        type="button"
        className="operator-modal__backdrop"
        data-layer-backdrop
        aria-label={`Close ${label}`}
        tabIndex={-1}
        onClick={close}
      />
      <div
        ref={frameRef}
        className={["operator-modal__frame", panelClassName].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-fill={fill ? "true" : undefined}
        style={width ? ({ "--operator-modal-width": `${width}px` } as CSSProperties) : undefined}
      >
        {title !== undefined ? (
          <OverlayHeader
            {...headerProps}
            title={title}
            status={status}
            actions={
              <IconButton aria-label={`Close ${label}`} title="Close (Esc)" onClick={close}>
                <X size={15} strokeWidth={1.75} />
              </IconButton>
            }
          />
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
