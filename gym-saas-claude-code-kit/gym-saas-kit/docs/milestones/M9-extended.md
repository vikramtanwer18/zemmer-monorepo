# M9 — Extended Capabilities

**Goal:** finish the business-management surface — expenses and profitability, inventory and point of sale,
branch transfers and advanced branch analytics, and tenant-defined custom roles. Prioritize items with the client
before starting; this milestone can be split.

Follow the session protocol in `docs/milestones/README.md`. Start by asking the product owner to rank the items
below and confirm which are in scope for this round.

## Read
- `docs/DECISIONS.md` D-07 (custom roles now allowed — record an amendment), D-10, D-11, D-15
- `MASTER_SPEC.md` Module 9 (expenses, trainer commissions), Module 17 (member transfers), Module 18, Module 14 (profitability, inventory reports)

## Candidate scope
1. **Expenses & profitability:** expense categories, suppliers, expense records (branch, date, amount, GST input tax fields, attachment), recurring expenses, approval for large amounts; profitability report = net revenue ex-tax − included expense categories, labelled estimate (KPI doc).
2. **Trainer commissions:** rules (percent of PT package, per session, per class), monthly statements, approval, export — visible only with compensation permission.
3. **Inventory:** product catalog (HSN, GST rate, price, cost), stock per branch, stock movements (purchase, sale, adjustment with reason, transfer between branches), purchase records, low-stock alerts (notification + automation trigger).
4. **POS:** quick-sale screen for staff (products + optional membership add-on), cart → invoice (D-11, separate from membership revenue lines) → payment (manual methods or payment link via M4) → receipt; refunds/returns restock; daily cash-up report per branch/staff.
5. **Member transfers between branches:** request/approve, membership access rule update, history; branch-level reporting follows the home branch change from the transfer date.
6. **Advanced branch analytics:** side-by-side branch KPIs, trends, per-branch targets.
7. **Custom roles:** tenant Owner/Admin creates roles from permission keys within platform-enforced limits (cannot grant platform or owner-only permissions), assigns them with branch scope; permission matrix doc generated per tenant; existing fixed roles remain as templates.
8. **Referral & loyalty extensions** (if M7 basics need more), **additional integrations** (Stripe adapter, accounting export such as Tally-compatible CSV), **franchise/white-label** — only if validated by the client.

## Tests required (per item chosen)
Stock never negative under concurrent sales (or explicitly allowed by setting); POS invoice + stock + payment atomic; custom role cannot escalate beyond granter's own permissions; transfers keep historical reports stable; commission math fixtures.

## Acceptance checklist
- [ ] Each item chosen meets the Definition of Done in `CLAUDE.md`.
- [ ] Inventory and POS accounting kept distinct from membership revenue in reports.
- [ ] Custom roles cannot escalate privilege (tests).
- [ ] Status doc reflects which candidate items were built, deferred, or dropped.
