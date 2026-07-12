
# Mount Realty / Kleegr Inventory Management System

Full rebuild from scratch per the Master Spec (v July 10, 2026). Kleegr-branded portal that acts as a strict gatekeeper between Excel/CSV inventory files and the GHL-compatible CRM, plus a real-time webhook engine that keeps Unit availability and Project/Building rollups in sync with Opportunity stage changes.

## What we're building (v1)

1. **Kleegr Import Center** — Upload XLSX/XLS/CSV, parse the 30-column Inventory Import sheet, validate (blocking + warnings), show Projects / Buildings / Units / Errors / Warnings previews, require explicit Confirm, then execute a server-side job that upserts to the CRM, creates associations, recalculates rollups, verifies read-back, and produces a downloadable Import Report.
2. **Inventory Dashboard** — Totals (Projects / Buildings / Units, Available / Reserved / Under Contract / Sold), inconsistent-status list, recent imports, hierarchy browser (expand Project → Buildings → Units) with search + filters, Unit detail with open-in-CRM link.
3. **Opportunity → Unit webhook engine** — Public `/api/public/webhooks/ghl/opportunity-stage` endpoint (HMAC-verified). Maps configured pipeline stage IDs to Unit state transitions (Reserved/Locked, Under Contract, Closed/Sold, controlled release). Enforces double-reservation protection, idempotent event replay guard, sold-reversal protection, and recalculates parent Building + Project counts.
4. **Import history + audit log** — Every import job and every automated Unit change stored with actor, timestamps, previous/new values, correlation IDs.
5. **Manual Corrections** (basic) — Authorized user can edit a Unit with a required reason; audit-logged, triggers recalculation.
6. **Auth** — Email/password + Google login. Roles table (`admin`, `importer`, `viewer`) via `has_role()` security-definer. Only `admin`/`importer` can execute imports.

Out of scope for v1 (deferred): client-facing portal, seller-contact linking beyond what CRM already stores, load testing at scale, dead-letter queue UI (we'll log + retry, but no full UI).

## Architecture

- **Stack**: TanStack Start (already scaffolded) + Tailwind v4 + shadcn.
- **Backend**: Lovable Cloud (Postgres + Auth + server functions). All CRM writes happen in `createServerFn` handlers; token is server-only.
- **CRM client**: One `kleegr.server.ts` module — fetch-based, timeouts, retry-with-Retry-After, redacted logs, correlation IDs, all requests scoped to configured `LOCATION_ID`.
- **Public route**: `src/routes/api/public/webhooks/ghl/opportunity-stage.ts` (bypasses auth; verifies shared-secret HMAC on raw body).
- **Excel/CSV parsing**: `xlsx` (SheetJS) in server functions only (Worker-safe pure JS).

## Database schema (Lovable Cloud / Postgres)

```text
profiles(id uuid pk → auth.users, email, full_name, created_at)
app_role enum: admin | importer | viewer
user_roles(id, user_id → auth.users, role app_role, unique(user_id, role))
has_role(_user_id, _role) → boolean  -- security definer

crm_config(id=1 singleton, location_id, project_object_id, building_object_id,
           unit_object_id, opportunity_pipeline_id,
           stage_reserved_id, stage_under_contract_id, stage_closed_id,
           stage_release_id, updated_at)

external_id_map(scope enum('project','building','unit'),
                external_import_id text, crm_record_id text,
                unique(scope, external_import_id))

import_jobs(id, user_id, filename, file_hash, mode, status
            enum('validating','awaiting_confirm','running','success',
                 'success_with_warnings','partial_failure','failed'),
            row_count, projects_created, projects_updated,
            buildings_created, buildings_updated,
            units_created, units_updated, skipped, warnings_count,
            errors_count, validation_snapshot jsonb, report jsonb,
            created_at, started_at, completed_at)

import_items(id, job_id → import_jobs, row_number, import_row_id,
             scope, action enum('create','update','skip','error'),
             matched_crm_id, source jsonb, proposed jsonb,
             existing jsonb, messages jsonb, status text, correlation_id)

audit_events(id, actor_user_id, kind, entity_scope, entity_crm_id,
             previous jsonb, next jsonb, reason text, correlation_id,
             created_at)

webhook_events(id, provider_event_id unique, pipeline_id, stage_id,
               opportunity_id, unit_crm_id, received_at, processed_at,
               outcome, raw jsonb)
```

Every table gets explicit `GRANT` + RLS. `user_roles` is read only through `has_role()`. `import_*` / `audit_events` / `webhook_events` are readable by `importer`/`admin`, writable by service_role only (all writes go through server functions).

## Import Center flow

```text
Upload  →  Parse (server fn)  →  Validate → Persist import_job (status=awaiting_confirm)
       →  Preview UI (5 tabs: Summary, Projects, Buildings, Units, Errors/Warnings)
       →  User clicks Confirm Import
       →  Server fn locks job, executes:
            1. Upsert Project (match: External Import ID → Code → block on ambiguity)
            2. Upsert Buildings (same matching cascade)
            3. Upsert Units (match: External Import ID → (Building + Unit Number))
            4. Create Project↔Building + Building↔Unit associations
            5. Recalculate + write rollups on affected Buildings, then Projects
            6. Read-back verification of each written record
            7. Finalize report (success / partial / failed)
       →  Report screen with Copy + Download CSV
```

## Files to create

```text
src/lib/kleegr/
  client.server.ts         # fetch wrapper: auth, retries, rate limit
  config.server.ts         # object IDs, field keys, location, token
  objects.server.ts        # upsert Project/Building/Unit, search, read-back
  associations.server.ts   # create + verify associations
  rollups.server.ts        # recalc Building + Project counts
  webhook.server.ts        # stage → unit transition + guards
  field-map.ts             # 30-col → CRM field keys, allowed values, normalizers

src/lib/import/
  parse.server.ts          # XLSX/CSV → rows
  validate.server.ts       # blocking + warnings, batch-mode detection
  plan.server.ts           # build preview: creates/updates/skips
  execute.server.ts        # confirmed job runner
  template.ts              # CSV template blob + column list

src/lib/import.functions.ts        # createServerFn: uploadAndValidate, confirmImport, getJob, listJobs
src/lib/inventory.functions.ts     # dashboard counts, browser query, unit detail, manual correction
src/lib/crm-config.functions.ts    # admin: read/update crm_config

src/routes/_authenticated.tsx             # auth gate
src/routes/_authenticated/index.tsx       # dashboard
src/routes/_authenticated/import/index.tsx           # Import Center (upload + template)
src/routes/_authenticated/import/$jobId.tsx          # preview + confirm + report
src/routes/_authenticated/import/history.tsx         # past jobs
src/routes/_authenticated/inventory/index.tsx        # hierarchy browser
src/routes/_authenticated/inventory/unit.$id.tsx     # unit detail + manual correction
src/routes/_authenticated/settings/crm.tsx           # admin-only CRM config (object IDs, stage mapping)

src/routes/api/public/webhooks/ghl/opportunity-stage.ts  # HMAC-verified webhook

src/routes/auth.tsx           # login/signup + Google
src/routes/index.tsx          # redirect → /dashboard or /auth
src/components/kleegr/*       # branded shell, nav, cards, preview tables
```

## Secrets required

- `KLEEGR_CRM_TOKEN` — GHL/Kleegr private integration token (you have this from the earlier build)
- `KLEEGR_LOCATION_ID` — the confirmed location `UpjC8IK37wMzeb1pc9D0` (also stored in `crm_config` so you can rotate without redeploy)
- `WEBHOOK_SHARED_SECRET` — auto-generated; you paste it into the GHL workflow that fires the webhook

Object/field/stage IDs live in `crm_config` so you edit them in the Settings screen, not in code.

## Kleegr branding

Neutral, professional real-estate palette (deep navy + warm accent + off-white), Inter for UI, semantic tokens only in `src/styles.css`. No mention of GoHighLevel / HighLevel / LeadConnector anywhere in user-facing copy.

## What I need from you before I start writing code

1. **Kleegr / GHL API token** — I'll open a secure form for `KLEEGR_CRM_TOKEN` after you confirm the plan.
2. **Location ID** — confirm `UpjC8IK37wMzeb1pc9D0` from the spec, or give the correct one.
3. **First-turn scope** — OK to ship (a) auth + Cloud schema + Kleegr client + Import Center full flow (upload → validate → preview → confirm → execute → report) + basic dashboard shell + webhook endpoint stub in this first build, and layer the inventory browser / manual corrections / stage-mapping polish in follow-ups? Or do you want everything in one turn?
4. **Auth**: email/password + Google — OK? Or email only?
