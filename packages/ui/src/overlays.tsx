"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "./cn";

// --- Dialog / Drawer --------------------------------------------------------------------

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
};

/**
 * Modal on the native <dialog>: the browser traps focus, makes the rest inert, closes on Escape
 * and returns focus to the opener.
 */
function useNativeDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handle = () => onClose();
    dialog.addEventListener("close", handle);
    return () => dialog.removeEventListener("close", handle);
  }, [onClose]);
  return ref;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: ModalProps) {
  const ref = useNativeDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto w-[min(36rem,calc(100%-2rem))] rounded-lg border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-foreground/40"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <div className="mt-1 text-sm text-muted">{description}</div>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-md p-1 hover:bg-background"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      <div className="px-6 py-4">{children}</div>
      {footer && (
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          {footer}
        </div>
      )}
    </dialog>
  );
}

/** Side panel (filters, detail views). Same native-dialog accessibility as Dialog. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = "right",
}: ModalProps & { side?: "left" | "right" }) {
  const ref = useNativeDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={cn(
        "m-0 h-dvh max-h-dvh w-[min(28rem,100%)] max-w-none border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-foreground/40",
        side === "right" ? "ml-auto border-l" : "mr-auto border-r",
      )}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {description && (
              <div className="mt-1 text-sm text-muted">{description}</div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-background"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}

// --- Toast ------------------------------------------------------------------------------

type ToastTone = "success" | "danger" | "info";
type ToastItem = { id: number; tone: ToastTone; message: string };

const ToastContext = createContext<
  ((message: string, tone?: ToastTone) => void) | null
>(null);

const TOAST_ICONS = {
  success: CheckCircle2,
  danger: XCircle,
  info: Info,
} as const;

/** Wrap the app once; then `useToast()(message, tone)`. Announced through a live region. */
export function ToastProvider({
  children,
  durationMs = 5000,
}: {
  children: ReactNode;
  durationMs?: number;
}) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback(
    (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
    [],
  );
  const show = useCallback(
    (message: string, tone: ToastTone = "success") => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss, durationMs],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6"
      >
        {toasts.map((toast) => {
          const Icon = TOAST_ICONS[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === "danger" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm shadow-lg"
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  toast.tone === "success" && "text-success",
                  toast.tone === "danger" && "text-danger",
                  toast.tone === "info" && "text-info",
                )}
              />
              <p className="flex-1 text-foreground">{toast.message}</p>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
                className="rounded p-0.5 hover:bg-background"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside <ToastProvider>");
  return show;
}
