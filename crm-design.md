# In-House CRM — Design Notes

> Working document. Captures the thinking behind replacing HubSpot with an in-house CRM module inside the Employee Tools portal (`employee-tools.kironinteractive.com`).

## Why we're doing this

- **HubSpot is too complex** for the team — busy UI, too many concepts most people don't use.
- **It's expensive** — and we already pay for the Employee Tools portal that can host our own CRM.
- **Our portal is the better home** — we already have auth, role-gated tile access, and a consistent UX pattern. The CRM becomes another tile alongside Proposals, NDAs, KYC, etc.
- **The killer feature HubSpot can't give us:** a true unified view of a Company that pulls together CRM data + Proposals + NDAs + KYC + Co-Marketing — because all of that already lives in our portal.

## Who uses it

| Department | Role | Primary Need |
|---|---|---|
| Sales | Owner / writer | Manage contacts, companies, deals, log activity |
| Account Management | Owner / writer | Manage existing accounts, renewals, health |
| Marketing | Reader | View contact lists, campaign attribution |
| Finance | Reader | Closed-won deals, contract values, invoice status |
| Support | Reader (filtered) | Know who to assist per deal (currently via Smartsheet) |
| Leadership | Reader | Pipeline, forecast, activity dashboards |

Same data, different lenses. Role determines which tile(s) appear and what fields/views render.

## Core data model (v1 — keep it small)

Four objects, full stop:

- **Companies** — the account
- **Contacts** — people at the account (FK to Company)
- **Deals** — opportunity with stage, value, owner, close date (FK to Company)
- **Activities** — notes, calls, emails, meetings on a single timeline (polymorphic FK to Company / Contact / Deal)

Anything beyond this (tickets, sequences, custom property groups, lists-of-lists) is deferred until a real workflow demands it.

### Cross-tile links (the unique value)

A Company page should surface:
- Open deals (CRM)
- Active proposals (Proposals tile)
- Signed NDAs & contracts (NDAs & Contracts tile)
- KYC status (KYC tile)
- Co-marketing campaigns (Co-Marketing tile)
- Tier 1 tracking notes (Tier 1 tile)

This is the unified account view HubSpot pretends to give and doesn't.

## Role-based views (first-load defaults)

- **Sales:** pipeline kanban, "my open deals," "my contacts"
- **Account Management:** "my accounts," upcoming renewals, account health signals
- **Marketing:** contact list (read-only), segmentation, campaign attribution (light)
- **Finance:** closed-won deals this period, contract values, invoice status
- **Support:** filtered deal view — who to contact per active deal (replaces Smartsheet zap)
- **Leadership:** pipeline value, forecast, activity volume by rep

## Workflows to replicate

Need to inventory the actual HubSpot workflows in use. Initial guesses:
- Lead assignment on inbound
- Deal stage change notifications (Slack/Teams)
- Renewal reminders for AM
- Sales → AM handoff on closed-won

**Action:** list the real workflows on one page before designing the engine. We almost certainly need far less than HubSpot offers.

## Integrations to replace

### Outlook (Microsoft Graph API)
- Email logging — pull sent/received emails, match by contact email, attach to timeline
- Calendar sync — pull meetings where a contact is an attendee, log to timeline
- Send-from-CRM — nice to have, deferred

### Asana
- Currently lightweight. Decide: full integration (REST API + webhooks for "task on stage change") or just a project URL field on Deals. Lean toward the latter unless usage justifies more.

### Zapier — current zaps to replace
1. **HubSpot → Portal (Proposals)** — pulls deal/company/contact data into the portal to generate proposals. *Replacement:* direct DB read once CRM lives in the portal. The zap disappears entirely.
2. **HubSpot → Portal (Contracts)** — same pattern, generates contracts. *Replacement:* same — direct DB read, zap disappears.
3. **HubSpot → Smartsheet (Support)** — feeds deal info to support team in Smartsheet. *Replacement:* a Support view/tile inside the portal showing exactly the same filtered deal info. Smartsheet dependency goes away.

**Observation:** all three current zaps exist *because* the CRM is external. Moving the CRM in-house collapses them into native portal features. This is a big win.

## Migration from HubSpot

- **One-time bulk export** of Companies, Contacts, Deals via HubSpot CSV export (or API for fidelity).
- **Activity history** — decide scope: migrate last 12–24 months, or archive a HubSpot export as static reference and start fresh.
- **Parallel running period** — keep HubSpot read-only for ~30 days as a safety net after cutover.
- **Owner mapping** — HubSpot user IDs → portal user accounts. Needs a mapping table at migration time.

## Architecture (high level)

- **Frontend:** new tile in the existing Next.js Employee Tools app. Reuses portal auth and layout.
- **Backend:** whatever the portal currently uses (TBD — confirm).
- **Database:** same portal DB, new tables for `companies`, `contacts`, `deals`, `activities`. FKs to existing tables (proposals, contracts, kyc, etc.) for the unified-view feature.
- **Auth/RBAC:** extend the existing tile-level access model to field-level / view-level for CRM (Marketing sees contacts but not deal values, etc.).
- **Integrations:** Microsoft Graph for Outlook; native API endpoints for what zaps used to do.

## Open questions

1. What stack does the Employee Tools portal use server-side? (Confirms where CRM logic lives.)
2. Full Zapier inventory — list every zap, not just the three above, so we know the real replacement scope.
3. Full HubSpot workflow inventory — same reasoning.
4. Custom properties in HubSpot today — which ones are actually used, which can be dropped at migration.
5. How much activity history must migrate vs. archive.
6. Reporting needs — what reports does leadership actually look at weekly/monthly? Drives the dashboard scope.

## Phased build (rough)

- **Phase 0 — Discovery:** inventory zaps, workflows, custom properties, HubSpot reports actually used.
- **Phase 1 — Core CRM:** Companies, Contacts, Deals, Activities. Manual entry only. Sales + AM start using it in parallel with HubSpot.
- **Phase 2 — Cross-tile views:** unified Company page pulling Proposals, NDAs, KYC, etc.
- **Phase 3 — Migration:** bulk import from HubSpot. Cut over Proposals + Contracts generation off Zapier and onto direct DB reads.
- **Phase 4 — Integrations:** Outlook email/calendar logging. Support view replaces Smartsheet zap.
- **Phase 5 — Workflows:** replicate the small set of HubSpot automations that matter.
- **Phase 6 — Cancel HubSpot.**

---

*Next session: pick one of the Open Questions to close, or start sketching the Phase 1 schema in detail.*
