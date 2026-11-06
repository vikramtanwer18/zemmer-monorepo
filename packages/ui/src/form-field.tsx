"use client";

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useFieldError } from "./action-form";
import { cn } from "./cn";

const controlClass =
  "w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60";

function useFieldIds(id: string | undefined, hint?: string, error?: string) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ");
  return { inputId, hintId, errorId, describedBy: describedBy || undefined };
}

function FieldShell({
  label,
  inputId,
  hint,
  hintId,
  error,
  errorId,
  required,
  children,
}: {
  label: string;
  inputId: string;
  hint?: ReactNode;
  hintId: string;
  error?: string;
  errorId: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export type FormFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  /** Overrides the error from the surrounding ActionForm. */
  error?: string;
};

/** Label + input + hint or error, linked through ids so screen readers read the error. */
export function FormField({
  label,
  hint,
  error,
  id,
  className,
  name,
  required,
  ...props
}: FormFieldProps) {
  const formError = useFieldError(name);
  const shown = error ?? formError;
  const ids = useFieldIds(id, hint, shown);
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={shown}
      required={required}
      {...ids}
    >
      <input
        id={ids.inputId}
        name={name}
        required={required}
        aria-invalid={shown ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cn(
          controlClass,
          "h-10",
          shown && "border-danger",
          className,
        )}
        {...props}
      />
    </FieldShell>
  );
}

export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string;
  options: { value: string; label: string }[];
  /** Adds an empty first option with this text. */
  placeholder?: string;
};

export function SelectField({
  label,
  hint,
  error,
  id,
  className,
  name,
  options,
  placeholder,
  required,
  ...props
}: SelectFieldProps) {
  const formError = useFieldError(name);
  const shown = error ?? formError;
  const ids = useFieldIds(id, hint, shown);
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={shown}
      required={required}
      {...ids}
    >
      <select
        id={ids.inputId}
        name={name}
        required={required}
        aria-invalid={shown ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cn(
          controlClass,
          "h-10",
          shown && "border-danger",
          className,
        )}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function TextareaField({
  label,
  hint,
  error,
  id,
  className,
  name,
  required,
  ...props
}: TextareaFieldProps) {
  const formError = useFieldError(name);
  const shown = error ?? formError;
  const ids = useFieldIds(id, hint, shown);
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={shown}
      required={required}
      {...ids}
    >
      <textarea
        id={ids.inputId}
        name={name}
        required={required}
        aria-invalid={shown ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cn(
          controlClass,
          "min-h-20 py-2",
          shown && "border-danger",
          className,
        )}
        {...props}
      />
    </FieldShell>
  );
}

export type CheckboxFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  label: string;
  hint?: string;
};

export function CheckboxField({
  label,
  hint,
  id,
  className,
  name,
  ...props
}: CheckboxFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const formError = useFieldError(name);
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <input
        id={inputId}
        name={name}
        type="checkbox"
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        className="mt-0.5 size-4 rounded border-border accent-primary"
        {...props}
      />
      <div className="flex flex-col gap-0.5">
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-foreground"
        >
          {label}
        </label>
        {hint && (
          <p id={`${inputId}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )}
        {formError && (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        )}
      </div>
    </div>
  );
}
