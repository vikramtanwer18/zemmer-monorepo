"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";

/**
 * Confirmation built on the native <dialog> (modal: focus is trapped and Escape closes it).
 * The confirm button submits `formAction` with the hidden `fields` plus anything in `children`
 * (e.g. a required "reason" field).
 */
export function ConfirmDialog({
  trigger,
  triggerVariant = "outline",
  triggerSize = "sm",
  title,
  description,
  confirmLabel,
  confirmVariant = "danger",
  formAction,
  fields,
  children,
}: {
  trigger: ReactNode;
  triggerVariant?: ButtonProps["variant"];
  triggerSize?: ButtonProps["size"];
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonProps["variant"];
  formAction: (formData: FormData) => void | Promise<void>;
  fields?: Record<string, string>;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClose = () => setPending(false);
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  return (
    <>
      <Button
        variant={triggerVariant}
        size={triggerSize}
        onClick={() => ref.current?.showModal()}
      >
        {trigger}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-lg border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-foreground/40"
      >
        <form
          action={async (formData) => {
            setPending(true);
            try {
              await formAction(formData);
            } finally {
              setPending(false);
              ref.current?.close();
            }
          }}
          className="flex flex-col gap-4 p-6"
        >
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <div className="text-sm text-muted">{description}</div>
          )}
          {Object.entries(fields ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {children}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" variant={confirmVariant} loading={pending}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
