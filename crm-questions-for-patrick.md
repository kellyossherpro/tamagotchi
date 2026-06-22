# CRM Tile — Questions for Patrick

A working doc for Kelly + Patrick to go through together. Goal: understand the portal's constraints before designing the CRM tile in detail.

**Context in one line:** Kelly is designing an in-house CRM as a tile in the Employee Tools portal to replace HubSpot. Most of the build will be done by Kelly with AI assistance; Patrick is the portal owner and review/deploy gate.

---

## 1. Tech stack

- What's the frontend framework and version? (Next.js — which version?)
- Is the backend Next.js API routes, or a separate service?
- What database? (Postgres / MySQL / other)
- Where is it hosted? (Vercel / AWS / self-hosted / other)
- Any libraries or patterns I should default to for forms, tables, state, styling?

## 2. Buy-in

- Are you happy in principle for me to add a CRM tile to the portal?
- Any concerns up front — security, performance, your own roadmap — I should know about?

## 3. How tiles get added

- Is there a template or pattern for adding a new tile?
- Does the new tile's code live in the same repo as the portal, or somewhere separate?
- How does a tile get permissioned / role-gated (the lock icon on certain tiles today)?

## 4. Auth and roles

- How does auth work? (Microsoft SSO / other)
- How does a tile know who the current user is and what role/department they're in?
- Is there an existing role list (Sales, AM, Marketing, Finance, Support, Leadership) or do roles get defined per tile?

## 5. Database changes

- If the CRM needs new tables (companies, contacts, deals, activities), what's the process?
- Migrations tool, or manual SQL?
- Do you run schema changes, or do I?
- Is there a dev/staging DB I can iterate against before touching production?

## 6. Deployment

- How does code get from a branch into production?
- Is there a staging environment?
- Auto-deploy on merge, or manual step?

## 7. Your role going forward

- I'm imagining you as the review-and-deploy gate, not a co-builder — does that work for you?
- Realistically, how much of your time per week/month should I plan around?
- What's the lightest-weight way for you to review changes before they ship?

## 8. Prior art and landmines

- Has anyone tried something similar in the portal before? Anything to learn from?
- Anything I should specifically **not** do? (Performance limits, data types you don't want stored, integrations that have been painful.)

## 9. Operational safety

- If I'm unavailable and something breaks, are you willing to be the emergency contact? At what level — "the tile is down" vs. "a field is wrong"?
- Does the portal back up its database? How often? Can data be restored to a point in time?

## 9b. Scheduled jobs

- The pipeline engine needs a daily background job: "find any deals where required-properties have been incomplete for 60 days → move them to On Hold." Does the portal have a scheduled job runner today (cron, background worker, scheduled function)? If not, what's the easiest way to add one?

## 9c. Sending email from the portal

- Notifications (handovers, stage changes, stale deals) need to be sent as email **and** stored in an in-CRM notification board.
- Does the portal already send transactional email from any other tile? If so, what does it use (SMTP relay, SendGrid, Microsoft Graph, other)?
- Any deliverability/SPF/DKIM constraints I should know about?

## 10. Integrations

- The CRM will eventually need Microsoft Graph (Outlook email/calendar logging). Has the portal connected to Graph before? Any auth/app-registration pieces already in place I can reuse?
- Three current Zapier zaps will collapse into the CRM (HubSpot → Proposals tile, HubSpot → Contracts tile, HubSpot → Smartsheet for Support). Any view on the cleanest way to wire those up internally once the data lives in the portal DB?

---

## What I want to walk away with

- **Stack + constraints** clearly written down (sections 1, 3, 4, 5, 6, 10)
- **Your green light in principle** (section 2, 7)
- **A short list of landmines** (sections 8, 9)

That goes into the CRM design doc as the "Portal constraints" section, and shapes everything we build from there.
