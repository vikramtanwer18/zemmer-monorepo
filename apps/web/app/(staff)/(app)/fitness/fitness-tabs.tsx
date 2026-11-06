import { Tabs } from "@gym/ui";

export function FitnessTabs({
  current,
  nutrition,
}: {
  current: string;
  nutrition: boolean;
}) {
  return (
    <Tabs
      label="Fitness sections"
      current={current}
      items={[
        { href: "/fitness", label: "Members" },
        { href: "/fitness/templates", label: "Workout templates" },
        { href: "/fitness/exercises", label: "Exercises" },
        ...(nutrition ? [{ href: "/fitness/foods", label: "Foods" }] : []),
      ]}
    />
  );
}
