# CRM — Definition of "Perfect Enough"

The checklist that triggers Phase D (cutover from HubSpot). If every box below is ticked, the CRM is ready to replace HubSpot. If any are unticked, it isn't — full stop.

**This is a draft.** Kelly to add / cut / edit. Revisit at the end of Phase A and again at the end of Phase B.

---

## 1. Must-have functionality

The CRM has to actually do these things before the team can touch it.

### Core CRUD
- [ ] Create, view, edit, delete Companies
- [ ] Create, view, edit, delete Contacts (linked to a Company)
- [ ] Create, view, edit, delete Deals (linked to a Company, with stage / value / owner / close date)
- [ ] Create, view, edit, delete Activities (notes, calls, emails, meetings) against Companies / Contacts / Deals
- [ ] Search across Companies and Contacts (name, email, domain)
- [ ] Activity timeline visible on a Company, Contact, and Deal page

### Pipeline & deal management
- [ ] Pipeline view (kanban or list) showing deals by stage
- [ ] All 11 stages present: Lead, Qualified Lead, Customer Engagement, Feasibility (RICE), Proposal, Legal & Compliance, Closed Won, Live, On Hold, Closed Lost, Terminated
- [ ] Filter pipeline by owner, close date, value
- [ ] Closed-won / closed-lost / terminated handling (reason + date captured)

### Stage-gate engine (per `sales_pipeline_process.docx`)
- [ ] Each stage's required-property list configured and enforced
- [ ] Auto-advance: when all required properties for current stage are complete → deal moves to next stage automatically
- [ ] 60-day stale rule: if required properties remain incomplete for 60 days → deal auto-moves to On Hold
- [ ] Branching at Customer Engagement: `Integration Type = Custom` → Feasibility (RICE); `Vanilla` → Proposal
- [ ] All required properties from the pipeline spec exist as fields on the Deal object (Lead: Deal Name, Deal Owner, Country, Lead Source… all the way through Live)
- [ ] On Hold reason dropdown, Closed Lost reason + date, Terminated yes/no + date
- [ ] Audit log of stage transitions (who/what/when), so we can debug stuck deals

### Document generation triggers
- [ ] Entering Proposal stage → Proposals tile auto-generates a proposal
- [ ] Entering Legal & Compliance stage → Contracts tile auto-generates a contract
- [ ] NDA generated when needed at Legal & Compliance (per touch-points diagram)

### Departmental handover triggers
- [ ] Dev/Tech notified when Integration Type = RICE (Customer Engagement / Feasibility)
- [ ] Legal notified when deal enters Legal & Compliance
- [ ] Marketing notified at Closed Won when Marketing Contact Email is added (Marketing Handover)
- [ ] Support notified at Closed Won when Support Contact Email is added (Support Handover)
- [ ] Finance notified when deal goes Live (Finance Handover — to Kelly + deal owner, contract forwarded)
- [ ] Collaborator routing on Proposal stage: Dieg for Africa deals, Sarah/Robert for International

### Notifications (delivery layer)
- [ ] Every notification fires **both** email and in-CRM notification board entry
- [ ] Notification board: inbox-style view per user, showing all alerts directed at them
- [ ] Mark-as-read and unread count badge on the CRM tile
- [ ] Filter notifications by type (handover / stage change / stale deal / mention)
- [ ] Notifications link back to the deal / company / contact that triggered them

### Role-based views
- [ ] Sales sees: pipeline kanban, my open deals, my contacts
- [ ] Account Management sees: my accounts, upcoming renewals
- [ ] Marketing sees: contact list (read-only, no deal values)
- [ ] Finance sees: closed-won deals, contract values
- [ ] Support sees: filtered deal view (replaces Smartsheet zap)
- [ ] Leadership sees: pipeline value, forecast, activity volume

### Cross-tile links (the unique value)
- [ ] Company page shows linked Proposals (from Proposals tile)
- [ ] Company page shows linked NDAs / Contracts (from NDAs & Contracts tile)
- [ ] Company page shows KYC status (from KYC tile)
- [ ] Company page shows Co-marketing campaigns (from Co-Marketing tile)
- [ ] Company page shows Tier 1 tracking notes (from Tier 1 tile)

### Zap replacements
- [ ] Proposals tile generates proposals from CRM data (not HubSpot)
- [ ] Contracts tile generates contracts from CRM data (not HubSpot)
- [ ] Support view replaces Smartsheet zap (same filtered info, in-portal)

### Workflows (beyond the stage engine)
- [ ] Lead assignment on inbound — working
- [ ] Deal stage change notifications (Slack/Teams) — working
- [ ] Renewal reminders for AM — working
- [ ] Sales → AM handoff on closed-won — working

### Outlook integration
- [ ] Email logging — sent/received emails matched to contacts and shown on timeline
- [ ] Calendar sync — meetings with contacts shown on timeline

---

## 2. Must-have quality bar

How well it has to work, not just whether it works.

- [ ] Kelly has used it as daily driver for at least **[X] weeks** (suggest 4) with no critical bugs
- [ ] No data loss bugs observed during solo use
- [ ] Page loads feel as fast as the rest of the Employee Tools portal
- [ ] Top 5 daily HubSpot tasks can be done in equal or fewer clicks (list the 5 and verify each)
- [ ] Mobile/responsive view usable for the things AM does on the road (or explicit decision: desktop only at launch)
- [ ] All forms validate properly — can't save bad data (e.g. deal with no Company)

---

## 3. Must-have safety

What has to be true before real team data lands in it.

- [ ] DB backups confirmed working (verified by Patrick — restore tested at least once)
- [ ] Permissions tested per role — Marketing genuinely cannot see deal values, Finance genuinely cannot edit, etc.
- [ ] Edit audit trail in place (who changed what, when) — OR explicit written decision that v1 doesn't need this
- [ ] Soft-delete on records (deleting doesn't actually destroy data for [X] days) — OR explicit decision otherwise
- [ ] HubSpot data import tested end-to-end with a real HubSpot export at least once on staging
- [ ] Owner mapping (HubSpot user IDs → portal user accounts) prepared and verified
- [ ] Rollback plan written: if cutover day fails, exactly what we do
- [ ] HubSpot read-only archive plan agreed (30 days), with final CSV backup location decided

---

## 4. Must-have communication

The team can't be ambushed.

- [ ] Cutover date communicated to the team at least 2 weeks in advance
- [ ] Training session scheduled (Sales + AM at minimum)
- [ ] Short written guide for the team — "here's how you do the 10 things you used to do in HubSpot"
- [ ] Patrick is briefed and available on cutover day

---

## How to use this list

- **Don't add features that aren't on this list during Phase A or B.** If you find something missing, add it here first, then build it. Forces you to make the "is this really required for cutover?" decision consciously.
- **Don't remove things lightly.** If you find yourself wanting to cut an item to ship faster, ask why. Sometimes the answer is genuine ("nobody actually does that"). Sometimes it's scope-creep-in-reverse ("I'm tired and want to be done").
- **Tick things off as you go.** Visible progress is motivating, and it makes the "are we there yet?" question objective.

---

## Anti-list (consciously NOT in "perfect enough")

These are explicitly **not required** for cutover, so they don't sneak in:

- Mobile app (responsive web only)
- Email sequences / marketing automation
- Forms / landing pages
- Live chat
- Ticketing
- Custom dashboards beyond the role default views
- API for external tools (beyond what Proposals/Contracts tiles need)
- Anything on the "Won't build" list in `crm-design.md`

If any of these turn out to matter post-launch, they're a v2 conversation.
