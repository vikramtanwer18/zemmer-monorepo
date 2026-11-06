# Gym SaaS — Claude Code Build Kit

Drop these files into the root of the new (empty) monorepo before the first Claude Code session.

```
CLAUDE.md                       Rules Claude Code reads every session
docs/DECISIONS.md               Binding decisions from the planning Q&A (override the spec)
docs/MASTER_SPEC.md             Your original master prompt, amended where decisions changed it
docs/KPI_DEFINITIONS.md         Draft metric definitions (needs client sign-off)
docs/IMPLEMENTATION_STATUS.md   Progress tracker Claude Code keeps updated
docs/milestones/README.md       Milestone map, session protocol, external prerequisites
docs/milestones/M0 … M9         One prompt per milestone
```

## How to run

1. `git init`, copy this kit in, commit.
2. Open Claude Code in the repo root and send:
   `Run the milestone in docs/milestones/M0-foundation.md`
3. Review the result against the milestone's acceptance checklist and `IMPLEMENTATION_STATUS.md`. Commit.
4. Start a **fresh session** for the next milestone (M1, M2, …). Large milestones (M2, M3, M4, M6) may need
   2–3 sessions; tell Claude Code to resume from the status doc.
5. M4 is the sellable MVP. Run M7 in parallel with M5–M6 if you have a second developer.

## Start now, outside the code

See the "Start these now" table in `docs/milestones/README.md` — especially the **Meta Tech Provider**
application (WhatsApp Embedded Signup), Razorpay test accounts, SES production access, and the client's CA
confirming GST details.
