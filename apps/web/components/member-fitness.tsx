import { getMyHealthConsent } from "@gym/core/fitness";
import type { MemberContext } from "@gym/core/members";
import { Card, CardTitle, SubmitButton, Tabs } from "@gym/ui";
import { healthConsentAction } from "@/app/(member)/m/(app)/workouts/actions";
import { services } from "@/lib/services";

export function TrainNav({
  current,
  nutrition,
  rewards,
}: {
  current: string;
  nutrition: boolean;
  rewards: boolean;
}) {
  const items = [
    { href: "/m/workouts", label: "Workouts" },
    { href: "/m/progress", label: "Progress" },
    ...(nutrition ? [{ href: "/m/nutrition", label: "Food" }] : []),
    ...(rewards ? [{ href: "/m/rewards", label: "Rewards" }] : []),
    { href: "/m/feed", label: "News" },
  ];
  return <Tabs label="Training sections" current={current} items={items} />;
}

/**
 * Health data needs the member's own consent first (separate from marketing). Shown in place of
 * the page until they agree; nothing is stored before that.
 */
export async function HealthConsentGate({
  mctx,
  back,
  children,
}: {
  mctx: MemberContext;
  back: string;
  children: React.ReactNode;
}) {
  const consent = await getMyHealthConsent(services().deps, mctx);
  if (consent.granted) return <>{children}</>;
  return (
    <Card className="flex flex-col gap-3" data-testid="health-consent">
      <CardTitle>Before you start tracking</CardTitle>
      <p className="text-sm">{consent.text}</p>
      <form action={healthConsentAction} className="flex flex-col gap-3">
        <input type="hidden" name="back" value={back} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="granted" required className="mt-1" />
          <span>I agree</span>
        </label>
        <div>
          <SubmitButton>Continue</SubmitButton>
        </div>
      </form>
      <p className="text-xs text-muted">
        Version {consent.currentVersion}. You can withdraw it any time in
        Privacy.
      </p>
    </Card>
  );
}

/** A small accessible line chart (SVG, no client JS). Values are shown in a table for screen readers. */
export function LineChart({
  title,
  unit,
  points,
}: {
  title: string;
  unit: string;
  points: { date: string; value: number }[];
}) {
  if (points.length === 0) return null;
  const w = 320;
  const h = 120;
  const pad = 24;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) =>
    points.length === 1
      ? w / 2
      : pad + (i * (w - 2 * pad)) / (points.length - 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = points
    .map(
      (p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`,
    )
    .join(" ");
  const last = points.at(-1)!;
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-muted">
          {last.value} {unit}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full text-primary"
        role="img"
        aria-label={`${title}: ${points.map((p) => `${p.date} ${p.value} ${unit}`).join(", ")}`}
      >
        <line
          x1={pad}
          x2={w - pad}
          y1={h - pad}
          y2={h - pad}
          className="stroke-border"
          strokeWidth="1"
        />
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r="3.5"
            fill="currentColor"
          />
        ))}
        <text x={pad} y={h - 6} className="fill-current text-[10px] opacity-60">
          {points[0]!.date}
        </text>
        <text
          x={w - pad}
          y={h - 6}
          textAnchor="end"
          className="fill-current text-[10px] opacity-60"
        >
          {last.date}
        </text>
        <text
          x={4}
          y={y(max) + 4}
          className="fill-current text-[10px] opacity-60"
        >
          {max}
        </text>
        {max !== min && (
          <text
            x={4}
            y={y(min) + 4}
            className="fill-current text-[10px] opacity-60"
          >
            {min}
          </text>
        )}
      </svg>
    </figure>
  );
}
