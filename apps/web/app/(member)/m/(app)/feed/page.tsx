import { myEngagement, myFeed, myFeedback } from "@gym/core/engagement";
import { Card, CardTitle, EmptyState } from "@gym/ui";
import type { Metadata } from "next";
import { TrainNav } from "@/components/member-fitness";
import { when } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "News" };

export default async function MemberFeedPage() {
  const { mctx } = await requireMember("/m/feed");
  const { deps } = services();
  const [eng, feed, feedback] = [
    await myEngagement(deps, mctx),
    await myFeed(deps, mctx),
    await myFeedback(deps, mctx),
  ];
  return (
    <>
      <h1 className="text-2xl font-semibold">News</h1>
      <TrainNav
        current="/m/feed"
        nutrition={eng.nutrition}
        rewards={eng.rewards}
      />
      {feedback.length > 0 && (
        <Card className="flex flex-col gap-2" data-testid="trainer-feedback">
          <CardTitle>From your trainer</CardTitle>
          {feedback.map((f) => (
            <div key={f.id} className="text-sm">
              <p>{f.body}</p>
              <p className="text-xs text-muted">
                {f.author} · {when(f.createdAt, mctx.timezone)}
                {f.target === "WORKOUT_LOG" && f.targetId && (
                  <>
                    {" · "}
                    <a
                      className="text-primary underline"
                      href={`/m/workouts/log/${f.targetId}`}
                    >
                      the workout
                    </a>
                  </>
                )}
              </p>
            </div>
          ))}
        </Card>
      )}
      {feed.announcements.length === 0 && feedback.length === 0 && (
        <EmptyState
          title="Nothing new"
          description="Gym news and your trainer's notes show up here."
        />
      )}
      {feed.announcements.map((a) => (
        <Card key={a.id} className="flex flex-col gap-1">
          <CardTitle>{a.title}</CardTitle>
          <p className="whitespace-pre-wrap text-sm">{a.body}</p>
          <p className="text-xs text-muted">
            {when(a.publishedAt, mctx.timezone)}
          </p>
        </Card>
      ))}
    </>
  );
}
