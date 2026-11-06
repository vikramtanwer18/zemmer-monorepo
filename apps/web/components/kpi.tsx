import type { KpiFigure } from "@gym/core/metrics";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { inr } from "@/lib/format";

/** Formats a KPI value for its unit: counts, money (paise), ratios (%), plain numbers. */
export function formatKpi(
  value: number | null | undefined,
  unit: KpiFigure["unit"] | "minutes",
  currency = "INR",
): string {
  if (value === null || value === undefined) return "—";
  if (unit === "money") return inr(value, currency);
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "number")
    return value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
  return Math.round(value).toLocaleString("en-IN");
}

function Change({ figure }: { figure: KpiFigure }) {
  if (figure.previous === null || figure.delta === null) return null;
  const up = figure.delta > 0;
  const flat = figure.delta === 0;
  const good =
    figure.higherIsBetter === null || flat
      ? null
      : up === figure.higherIsBetter;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const size =
    figure.unit === "ratio"
      ? `${Math.abs(figure.delta * 100).toFixed(1)} pts`
      : figure.pct !== null
        ? `${Math.abs(figure.pct * 100).toFixed(0)}%`
        : formatKpi(Math.abs(figure.delta), figure.unit);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${good === null ? "text-muted" : good ? "text-success" : "text-danger"}`}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span>
        {flat ? "No change" : `${up ? "+" : "−"}${size}`}
        <span className="text-muted">
          {" "}
          vs {formatKpi(figure.previous, figure.unit)}
        </span>
      </span>
    </span>
  );
}

/**
 * One KPI: value, change vs the previous period, how it was built (numerator/denominator), the
 * definition behind a disclosure, and a link to the records it's made of.
 */
export function KpiCard({
  figure,
  href,
  currency,
}: {
  figure: KpiFigure;
  href?: string | null;
  currency?: string;
}) {
  // What the numerator/denominator are measured in (most are counts).
  const part = (v: number) =>
    figure.key === "dues.collection_rate"
      ? formatKpi(v, "money", currency)
      : figure.key === "trainers.utilization"
        ? `${(v / 60).toLocaleString("en-IN", { maximumFractionDigits: 1 })} h`
        : formatKpi(
            v,
            figure.key === "attendance.avg_visits" ? "number" : "count",
          );
  const parts =
    figure.numerator !== undefined && figure.denominator !== undefined
      ? `${part(figure.numerator)} ${figure.unit === "number" ? "÷" : "of"} ${part(figure.denominator)}`
      : null;
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4"
      data-kpi={figure.key}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-muted">{figure.label}</span>
        {figure.inProgress && (
          <span
            className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted"
            title="The window this figure depends on hasn't closed yet"
          >
            In progress
          </span>
        )}
      </div>
      <span className="text-2xl font-semibold" data-kpi-value>
        {formatKpi(figure.value, figure.unit, currency)}
      </span>
      {parts && <span className="text-xs text-muted">{parts}</span>}
      {figure.note && <span className="text-xs text-muted">{figure.note}</span>}
      <Change figure={figure} />
      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
        <details className="group">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            Definition
          </summary>
          <p className="mt-1 max-w-xs text-muted">{figure.definition}</p>
        </details>
        {href && (
          <a href={href} className="text-primary hover:underline">
            View records
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Single-series daily bars (server-rendered SVG). Native hover tooltip per bar with a full-height
 * hit target, a recessive baseline, first/last date labels, and a table view for screen readers.
 */
export function TrendBars({
  title,
  points,
  unit,
  currency,
}: {
  title: string;
  points: { day: string; value: number | null }[];
  unit: "count" | "money";
  currency?: string;
}) {
  if (!points.length) return null;
  const w = 640;
  const h = 160;
  const top = 12;
  const bottom = 22;
  const values = points.map((p) => p.value ?? 0);
  const max = Math.max(...values, 1);
  const slot = w / points.length;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const plotH = h - top - bottom;
  const total = values.reduce((a, b) => a + b, 0);
  const fmt = (v: number | null) => formatKpi(v, unit, currency);
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-muted">Total {fmt(total)}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full text-primary"
        role="img"
        aria-label={`${title}, ${points.length} days, total ${fmt(total)}`}
      >
        <line
          x1={0}
          x2={w}
          y1={h - bottom}
          y2={h - bottom}
          className="stroke-border"
          strokeWidth="1"
        />
        {points.map((p, i) => {
          const v = p.value ?? 0;
          const bh =
            p.value === null ? 0 : Math.max(v > 0 ? 2 : 0, (v / max) * plotH);
          const x = i * slot + (slot - barW) / 2;
          const y = h - bottom - bh;
          const r = Math.min(4, barW / 2, bh);
          return (
            <g key={p.day}>
              <title>{`${p.day}: ${p.value === null ? "no data" : fmt(p.value)}`}</title>
              <rect
                x={i * slot}
                y={top}
                width={slot}
                height={plotH}
                fill="transparent"
              />
              {bh > 0 && (
                <path
                  d={`M${x},${h - bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${h - bottom} Z`}
                  fill="currentColor"
                />
              )}
            </g>
          );
        })}
        <text
          x={0}
          y={h - 6}
          className="fill-current text-[11px] text-muted"
          style={{ fill: "var(--color-muted, currentColor)" }}
        >
          {points[0]!.day}
        </text>
        <text
          x={w}
          y={h - 6}
          textAnchor="end"
          className="fill-current text-[11px]"
          style={{ fill: "var(--color-muted, currentColor)" }}
        >
          {points.at(-1)!.day}
        </text>
      </svg>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted hover:text-foreground">
          Show as table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted">
                <th className="py-1 pr-4 font-medium">Day</th>
                <th className="py-1 font-medium">{title}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day} className="border-t border-border">
                  <td className="py-1 pr-4">{p.day}</td>
                  <td className="py-1">{fmt(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
