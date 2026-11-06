import { Tabs } from "@gym/ui";

export function EngagementTabs({
  current,
  rewards,
}: {
  current: string;
  rewards: boolean;
}) {
  return (
    <Tabs
      label="Engagement sections"
      current={current}
      items={[
        { href: "/engagement", label: "Announcements" },
        ...(rewards
          ? [
              { href: "/engagement/challenges", label: "Challenges" },
              { href: "/engagement/rewards", label: "Rewards & streaks" },
              { href: "/engagement/redemptions", label: "Pickups" },
              { href: "/engagement/referrals", label: "Referrals" },
            ]
          : []),
      ]}
    />
  );
}
