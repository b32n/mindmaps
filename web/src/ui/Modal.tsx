import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./Icons";

/**
 * A dialog rendered into a portal at the document root.
 *
 * Portalling matters here: the board sits inside transformed, clipped and
 * z-indexed containers, so a modal rendered in place would be trapped by them.
 *
 * Escape closes, clicking the scrim closes, and the first focusable element in
 * the body receives focus on open so the keyboard path works without a click.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // let the dialog paint before grabbing focus, or autoFocus fights us
    const t = setTimeout(() => {
      body.current?.querySelector<HTMLElement>(
        "input, textarea, select, button, [tabindex]:not([tabindex='-1'])",
      )?.focus();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            <IconClose size={18} />
          </button>
        </header>

        <div className="modal-body" ref={body}>
          {children}
        </div>

        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
