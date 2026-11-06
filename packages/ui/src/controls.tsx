"use client";

import { ChevronDown, Check, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "./cn";

// --- IconButton -------------------------------------------------------------------------

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  variant?: "ghost" | "outline" | "primary";
  size?: "sm" | "md";
};

export function IconButton({
  icon: Icon,
  label,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "size-8" : "size-10",
        variant === "ghost" && "text-foreground hover:bg-foreground/5",
        variant === "outline" &&
          "border border-border bg-surface text-foreground hover:bg-background",
        variant === "primary" &&
          "bg-primary text-primary-foreground hover:bg-primary/90",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}

// --- Switch -----------------------------------------------------------------------------

export type SwitchProps = {
  label: string;
  hint?: string;
  /** Form field name; a hidden input carries "on" when checked. */
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
};

/** Toggle with role="switch". Controlled or uncontrolled. */
export function Switch({
  label,
  hint,
  name,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
}: SwitchProps) {
  const id = useId();
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;
  const toggle = () => {
    if (disabled) return;
    setInner(!on);
    onCheckedChange?.(!on);
  };
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby={hint ? `${id}-hint` : undefined}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60",
          on ? "bg-primary" : "bg-border",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-5 rounded-full bg-surface shadow transition-transform",
            on ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
      {name && on && <input type="hidden" name={name} value="on" />}
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

// --- RadioGroup -------------------------------------------------------------------------

export type RadioOption = { value: string; label: string; hint?: string };

export function RadioGroup({
  legend,
  name,
  options,
  defaultValue,
  value,
  onValueChange,
  disabled,
}: {
  legend: string;
  name: string;
  options: RadioOption[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-foreground">
        {legend}
      </legend>
      {options.map((option) => {
        const optionId = `${id}-${option.value}`;
        return (
          <div key={option.value} className="flex items-start gap-3">
            <input
              id={optionId}
              type="radio"
              name={name}
              value={option.value}
              defaultChecked={
                value === undefined ? defaultValue === option.value : undefined
              }
              checked={value === undefined ? undefined : value === option.value}
              onChange={() => onValueChange?.(option.value)}
              aria-describedby={option.hint ? `${optionId}-hint` : undefined}
              className="mt-0.5 size-4 accent-primary"
            />
            <div className="flex flex-col gap-0.5">
              <label htmlFor={optionId} className="text-sm text-foreground">
                {option.label}
              </label>
              {option.hint && (
                <p id={`${optionId}-hint`} className="text-xs text-muted">
                  {option.hint}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

// --- Combobox ---------------------------------------------------------------------------

export type ComboboxOption = { value: string; label: string };

/**
 * Searchable single select (ARIA 1.2 combobox pattern). Arrow keys move, Enter picks,
 * Escape closes. The chosen value is submitted through a hidden input named `name`.
 */
export function Combobox({
  label,
  name,
  options,
  defaultValue,
  placeholder = "Type to search",
  onValueChange,
  emptyText = "No matches",
}: {
  label: string;
  name?: string;
  options: ComboboxOption[];
  defaultValue?: string;
  placeholder?: string;
  onValueChange?: (value: string) => void;
  emptyText?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [value, setValue] = useState(defaultValue ?? "");
  const [query, setQuery] = useState(
    options.find((o) => o.value === defaultValue)?.label ?? "",
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.toLowerCase()),
  );

  const pick = (option: ComboboxOption) => {
    setValue(option.value);
    setQuery(option.label);
    setOpen(false);
    onValueChange?.(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = filtered[active];
      if (option) pick(option);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && filtered[active] ? `${listId}-${active}` : undefined
        }
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted"
      />
      {name && <input type="hidden" name={name} value={value} />}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute top-full z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">{emptyText}</li>
          ) : (
            filtered.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(option);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex cursor-pointer items-center justify-between px-3 py-2 text-sm",
                  index === active && "bg-background",
                )}
              >
                {option.label}
                {option.value === value && (
                  <Check aria-hidden="true" className="size-4 text-primary" />
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// --- DropdownMenu -----------------------------------------------------------------------

export type MenuItem =
  | { label: string; href: string; danger?: boolean }
  | { label: string; onSelect: () => void; danger?: boolean };

/** Menu button pattern: Enter/Space/ArrowDown open, arrows move, Escape closes and refocuses. */
export function DropdownMenu({
  label,
  items,
  align = "end",
}: {
  label: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(`[data-menu="${id}"]`))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, id]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (current + step + items.length) % items.length;
      itemRefs.current[next]?.focus();
    } else if (event.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const itemClass = (danger?: boolean) =>
    cn(
      "block w-full px-3 py-2 text-left text-sm outline-none hover:bg-background focus:bg-background",
      danger ? "text-danger" : "text-foreground",
    );

  return (
    <div className="relative" data-menu={id}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm font-medium text-foreground hover:bg-foreground/5"
      >
        {label}
        <ChevronDown aria-hidden="true" className="size-4" />
      </button>
      {open && (
        <div
          id={`${id}-menu`}
          role="menu"
          onKeyDown={onMenuKey}
          className={cn(
            "absolute top-full z-30 mt-1 min-w-44 rounded-md border border-border bg-surface py-1 shadow-lg",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, index) =>
            "href" in item ? (
              <a
                key={item.label}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                role="menuitem"
                tabIndex={-1}
                href={item.href}
                className={itemClass(item.danger)}
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={itemClass(item.danger)}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
