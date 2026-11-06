import { cn } from "./cn";

/** Link tabs: each tab is a page, so the current tab survives reloads and shares as a URL. */
export function Tabs({
  items,
  current,
  label,
}: {
  items: { href: string; label: string }[];
  current: string;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="mb-6 overflow-x-auto border-b border-border"
    >
      <ul className="flex gap-1">
        {items.map((item) => {
          const active = item.href === current;
          return (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted hover:text-foreground",
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
