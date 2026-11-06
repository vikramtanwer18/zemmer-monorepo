"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useRef,
  type FormHTMLAttributes,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";
import { Alert } from "./layout";
import { Button, type ButtonProps } from "./button";

/** The shape every server action returns (see @gym/core/errors ActionResult). */
export type FormActionResult =
  | { ok: true; message?: string; data?: unknown }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        fields?: Record<string, string[]>;
      };
    };

export type FormAction = (
  previous: FormActionResult | null,
  formData: FormData,
) => Promise<FormActionResult>;

const FormStateContext = createContext<FormActionResult | null>(null);

/** Field errors for `name` from the nearest ActionForm, if any. */
export function useFieldError(name: string | undefined): string | undefined {
  const state = useContext(FormStateContext);
  if (!name || !state || state.ok) return undefined;
  return state.error.fields?.[name]?.[0];
}

export type ActionFormProps = Omit<
  FormHTMLAttributes<HTMLFormElement>,
  "action" | "children"
> & {
  action: FormAction;
  children: ReactNode;
  /** Shown after a successful submit (unless the action returns its own message). */
  successMessage?: string;
  /** Clears the inputs after success (e.g. invite forms). */
  resetOnSuccess?: boolean;
  /** Called after a successful submit. */
  onSuccess?: (result: Extract<FormActionResult, { ok: true }>) => void;
};

/**
 * Server-action form with error and success messages. Works without JavaScript (progressive
 * enhancement); with it, field errors appear under each FormField by name.
 */
export function ActionForm({
  action,
  children,
  successMessage,
  resetOnSuccess,
  onSuccess,
  className,
  ...props
}: ActionFormProps) {
  const [state, formAction] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) formRef.current?.reset();
      onSuccess?.(state);
    }
    // Only react to new results (onSuccess identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const message = state?.ok ? (state.message ?? successMessage) : undefined;
  const hasFieldErrors =
    state &&
    !state.ok &&
    state.error.fields &&
    Object.keys(state.error.fields).length > 0;

  return (
    <FormStateContext.Provider value={state}>
      <form
        ref={formRef}
        action={formAction}
        className={className}
        noValidate
        {...props}
      >
        {state && !state.ok && (
          <Alert tone="danger" className="mb-4">
            {hasFieldErrors && state.error.code === "VALIDATION_FAILED"
              ? (state.error.fields?._?.[0] ?? state.error.message)
              : state.error.message}
          </Alert>
        )}
        {message && (
          <Alert tone="success" className="mb-4">
            {message}
          </Alert>
        )}
        {children}
      </form>
    </FormStateContext.Provider>
  );
}

/** Submit button that shows a spinner while its form is pending. */
export function SubmitButton({
  children,
  ...props
}: Omit<ButtonProps, "type" | "loading">) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...props}>
      {children}
    </Button>
  );
}
