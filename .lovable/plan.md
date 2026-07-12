## Goal

Three additions, none of which should break the existing Unit-based flow:

1. **Building-level opportunities** — support cases where the "thing being sold" is a whole Building (villa/house), not a Unit inside it.
2. **Sync from CRM** — one-click import of all existing Projects, Buildings, and Units already in GHL, so the dashboard reflects reality even for records not created through the Import Center.
3. **CRM ID lookup helpers** — searchable pickers so users don't have to hunt IDs manually in GHL URLs.

---

## Part 1: Building-level opportunities (safe, opt-in)

**How it stays safe:** the webhook keeps working exactly as today for Units. We add an optional second path — if the payload contains `building_crm_id` (and no `unit_crm_id`), the backend applies the stage change to the Building's rollup fields instead.

**Backend changes:**
- Extend `stage-apply.server.ts`:
  - Accept new field `buildingCrmIdHint` on `StageChangeInput`.
  - If a Unit reference exists → current logic (unchanged).
  - Else if a Building reference exists → apply availability/stage to Building record directly and skip the "sum of Units" rollup for that building (since it IS the sellable item).
  - Else → same grace window (`pending_no_unit` — renamed to `pending_no_target` internally, still displayed as "pending").
- Extend `opportunity-stage.ts` webhook payload schema to accept `building_crm_id` and `building_external_import_id`.
- Extend Pending Events UI: the Apply input becomes a small dropdown (Unit / Building) + the ID field.

**GHL setup for building-only sales:** salesperson associates the **Building** record to the Opportunity instead of a Unit. Same manual flow, no new triggers needed.

---

## Part 2: Sync from CRM

**New page:** `/settings/sync` (admin only)

**What it does:** paginated fetch of every record from all three CRM custom objects using the existing `client.server.ts`, then upserts into `external_id_map` and `unit_state`. Safe to re-run: it matches on CRM record ID, updates existing mappings, never creates duplicates in CRM.

**UI:**
- One button per scope ("Sync Projects", "Sync Buildings", "Sync Units") + "Sync All"
- Live progress: "Syncing Units… 340 / 1,200"
- Result summary: created / updated / skipped / errors
- Runs as a server function; UI polls a `sync_jobs` table for progress

**New table:** `sync_jobs` (id, scope, status, total, processed, errors, started_at, finished_at)

**After sync:** dashboard counts, `/inventory` list, and CRM ID pickers (Part 3) all populate automatically.

---

## Part 3: CRM ID lookup helpers

Once Part 2 has run, we have every record's CRM ID in the local database. This unlocks:

**In the Pending Events card:** replace the raw text input with a **searchable combobox** — type "Villa 12" or "Tower A / Unit 305" → it lists matches → click one → auto-fills the CRM ID. No more copying from GHL URLs.

**Standalone tool: `/tools/id-lookup`** (admin only)
- Search bar across Projects / Buildings / Units
- Filter by scope
- Each result row shows: name, code, CRM ID (copy-to-clipboard button), parent hierarchy
- Useful for GHL admins configuring workflows

**Backend:** new server fn `searchCrmRecords({ scope?, query, limit })` returning `{ crmId, name, code, scope, parentName }[]`.

---

## Database changes

```text
sync_jobs (new)
  id uuid PK
  scope text          -- 'project' | 'building' | 'unit' | 'all'
  status text         -- 'running' | 'success' | 'partial' | 'failed'
  total int, processed int, created int, updated int, errors int
  started_at, finished_at, error_summary text
  started_by uuid → auth.users

external_id_map (existing) — add:
  display_name text   -- cached from CRM for the ID picker
  code text           -- project/building code, or unit number
  parent_crm_id text  -- for hierarchy display
```

---

## Files touched / added

- `src/lib/kleegr/stage-apply.server.ts` — add Building branch
- `src/routes/api/public/webhooks/ghl/opportunity-stage.ts` — accept building fields
- `src/lib/sync.functions.ts` (new) — start/list/status server fns
- `src/lib/sync/run.server.ts` (new) — the actual sync worker
- `src/lib/crm-search.functions.ts` (new) — searchable ID lookup
- `src/routes/_authenticated/settings/sync.tsx` (new)
- `src/routes/_authenticated/tools/id-lookup.tsx` (new)
- `src/components/kleegr/PendingEventsCard.tsx` — combobox + scope switch
- `src/components/kleegr/AppShell.tsx` — nav entries for new pages
- Migration: `sync_jobs` table + extend `external_id_map`

---

## Rollout order

1. **Migration** (sync_jobs + external_id_map columns)
2. **Part 2 backend + UI** (sync runs, populates local mirror)
3. **Part 3 backend + pickers** (uses data from step 2)
4. **Part 1 backend + PendingEventsCard update** (uses pickers from step 3)

This ordering means each part is testable on its own. Building support ships last so it's built on top of the polished picker UX rather than being another raw-text-input field.

---

## Explicit non-goals (to keep scope sane)

- No changes to how imports work (Excel Import Center stays as-is).
- No auto-scheduled sync (runs on-demand only; can add cron later if needed).
- No changes to GHL — everything is one-way (GHL → app).
- No new webhook types.
