import { Tabs } from "@gym/ui";

export function ClassesTabs({ current }: { current: string }) {
  return (
    <Tabs
      label="Classes sections"
      current={current}
      items={[
        { href: "/classes", label: "Schedule" },
        { href: "/classes/templates", label: "Recurring classes" },
        { href: "/classes/setup", label: "Rooms & categories" },
      ]}
    />
  );
}
