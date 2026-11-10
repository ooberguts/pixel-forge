import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Native modal semantics supply focus containment, Escape, and focus restoration. */
export function Dialog({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`utility-dialog${className ? ` ${className}` : ''}`}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

type Confirmation = { title: string; description: string; action: string };
export function useConfirmation() {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const resolve = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => resolve.current?.(false), []);
  const finish = (accepted: boolean) => {
    resolve.current?.(accepted);
    resolve.current = null;
    setPending(null);
  };
  return {
    confirm: (details: Confirmation) =>
      new Promise<boolean>((done) => {
        resolve.current?.(false);
        resolve.current = done;
        setPending(details);
      }),
    confirmation: pending && (
      <Dialog title={pending.title} onClose={() => finish(false)}>
        <h2>{pending.title}</h2>
        <p>{pending.description}</p>
        <div className="dialog-actions">
          <button className="button subtle" autoFocus onClick={() => finish(false)}>
            Cancel
          </button>
          <button className="button primary" onClick={() => finish(true)}>
            {pending.action}
          </button>
        </div>
      </Dialog>
    ),
  };
}
