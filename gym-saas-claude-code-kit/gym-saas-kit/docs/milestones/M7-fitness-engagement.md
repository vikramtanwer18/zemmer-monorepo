# M7 — Fitness Programs, Nutrition & Engagement

**Goal:** trainers build and assign workout and diet plans; members follow and log them in the PWA; assessments
and progress are tracked; streaks, milestones, challenges, rewards, and referrals keep members engaged — with
health data treated as sensitive.

Follow the session protocol in `docs/milestones/README.md`. Can run in parallel with M5–M6 (depends on M3 only).

## Read
- `docs/DECISIONS.md` D-07, D-08, D-09 (streak inputs come from attendance)
- `MASTER_SPEC.md` Module 7, Module 8, Module 16, §7C (workouts, nutrition, goals, trainer feedback, referrals), §13 (health data)

## Data model (confirm before migrating)
`Exercise` (global library seeded + tenant custom: name, muscle groups, equipment, instructions, media reference URL/file, difficulty), `WorkoutTemplate`, `WorkoutPlan` (member-specific copy, weeks/days), `WorkoutPlanDay`, `WorkoutPlanItem` (exercise, sets, reps/time, weight guidance, rest, notes), `WorkoutAssignment` (trainer, member, start/end, status), `WorkoutLog` + `SetLog`, `PersonalRecord` (derived on write with source log id), `FitnessAssessment` (date, metrics JSON with schema: weight, body fat %, measurements, tests), `Goal` (type, target, deadline, status), `NutritionPlan`, `MealPlanItem`, `FoodItem` (tenant/global library with per-100 g macros + source), `FoodLog` (portion, estimated macros, source, assumptions, user-corrected flag), `WaterLog`, `TrainerFeedback`, `HealthDataConsent`, `StreakState`, `Achievement` + `MemberAchievement`, `Challenge` + `ChallengeParticipant`, `RewardRule`, `RewardLedger`, `RewardRedemption`, `Referral` (referrer member, referred lead/member, status, reward issued).

## Build (in this order)
1. **Health-data consent & access:** before any fitness/nutrition data is stored, the member accepts a specific health-data consent (separate from marketing). Access: member (own), assigned trainers (assigned members only), Owner/Admin with `fitness.view_all`. Receptionists, sales, accountants: no access. Logged reads for sensitive views. Excluded from exports unless `fitness.export`.
2. **Exercise library:** seeded global library (~150 common exercises, original descriptions — no copied text), tenant custom exercises, search/filter, media via uploaded files or links.
3. **Workout plans:** template builder (weeks → days → exercises with sets/reps/time/rest), assign to member (creates a copy), edit assigned plan with version history; member PWA "Today's workout" with set-by-set logging, rest timer, notes; completion tracking; PRs computed from logs.
4. **Assessments & goals:** trainer records assessments; progress charts (Recharts) for weight, measurements, PRs; goals with status. Copy is non-medical: no diagnoses, no medical claims; disclaimer on plan pages.
5. **Nutrition:** trainer-assigned diet plans (meals, targets), member food logging (pick from library or custom entry; macros estimated from library × portion, **source and assumptions stored and shown**, member can correct), water logging, weekly summaries vs targets labelled "estimates".
6. **Trainer feedback & announcements:** trainer comments on logs/assessments with notifications to the member; gym announcements to members (all / branch / plan segment) shown in the PWA feed and as in-app notifications.
7. **Streaks & milestones:** definitions documented in `KPI_DEFINITIONS.md` (e.g. weekly streak = weeks with ≥ N check-ins; paused membership freezes the streak; expired resets after grace). Milestones (10/25/50/100 visits, plan completions, PRs). Avoid rewarding daily maximum-volume behaviour: cap counted visits at 1/day and do not reward consecutive days beyond a configured rest-aware rule.
8. **Challenges & leaderboards:** tenant-created challenges (attendance or workout-completion based — not body-weight loss leaderboards), opt-in participation, optional leaderboard with display-name choice.
9. **Rewards & referrals:** reward rules (points for visits, referrals, challenge completion), ledger, redemption (as member credit via M2 ledger, or a staff-fulfilled perk), referral link/code per member → lead (M5) attribution → reward issued when referred member pays (emits `referral.converted` for M6).

## Tests required
- Unit: PR detection, macro estimation & rounding, streak rules incl. pause/expiry, reward rule evaluation, referral reward once only.
- Integration: trainer cannot read non-assigned member's health data; receptionist denied; member A cannot read member B's logs; health data absent from general member export; redemption to credit is atomic.
- E2E: trainer builds template → assigns → member logs a workout in PWA → PR appears → trainer leaves feedback → member sees notification; referral → lead → paid → reward credited.

## Out of scope
AI-generated plans (M8 adds a trainer-reviewed draft option), wearables integrations.

## Acceptance checklist
- [ ] Trainer authoring and member tracking work end to end on mobile.
- [ ] Health data protected by consent + strict access rules (tests prove it).
- [ ] Nutrition estimates show source and uncertainty; members can correct them.
- [ ] Streak/reward rules documented and tested; no reward for unsafe overtraining patterns.
- [ ] All checks pass; status doc updated.
