# Flexible CSV Import System

Replace the rigid 30-column "Unit-row" template with a flexible importer that accepts Projects, Buildings, Units — separately or together — with optional relationships and user-chosen behavior for missing parents and duplicates. The existing template flow becomes one preset inside the new system.

## User flow

```text
1. Upload CSV / XLSX (drag-and-drop)
2. Detect entity type(s) from headers → user confirms
3. Map CSV columns → system fields (auto-mapped where obvious)
4. Choose behavior:
     • On duplicate:            Skip | Update | Create duplicate
     • Duplicate key:            Name | Code | External ID | Record ID
     • Missing parent Project:   Auto-create | Leave unassigned | Fail row
     • Missing parent Building:  Auto-create | Leave unassigned | Fail row
5. Preview: total / valid / invalid / duplicates / auto-creates + first 20 rows
6. Confirm → row-by-row import (failures don't stop the run)
7. Report: imported / updated / skipped / failed / auto-created,
   with a "Download failed rows" CSV
```

## Entity detection & mapping

- Header sniffer scores each row's headers against three field dictionaries (Project / Building / Unit) and picks any that pass a threshold. A single file may contain one, two, or all three entity types (columns that only make sense for one entity gate it in or out).
- Auto-map step matches header text to system fields (case/whitespace tolerant, common aliases: "Unit #" → Unit Number, "Sale Price" → Asking / Sale Price). User can override every mapping in a table.
- Field dictionaries mirror what already exists in `src/lib/kleegr/field-map.ts` — Project / Building / Unit — plus new "external key" fields: CRM Record ID, External ID, Name, Code.

## Relationship resolution (per row, per scope)

For each Unit row, in order:
1. If Building Record ID or Building External ID or Building Code present → resolve via `external_id_map` and CRM lookup.
2. Else if Building Name present → resolve within the row's Project (if any), then globally.
3. Else → follow user's "missing parent Building" choice.

Same three-step ladder for Project on Building rows. "Auto-create" writes a stub CRM record with just the name/code and records it in `external_id_map` so later rows in the same file reuse it.

## Duplicate detection

- Chosen key (Name / Code / External ID / Record ID) resolves against `external_id_map` first, then a live CRM search when no map hit exists.
- Behavior per user choice: `skip` (no write, counts as skipped), `update` (PATCH with only mapped fields), `create_duplicate` (POST new record; warned in preview).

## Preview & confirm

Preview screen extends the existing `import_items` table with:
- `resolution`: `create` | `update` | `skip` | `create_duplicate` | `auto_create_parent` | `error`
- `parent_resolution`: how the row's parents were matched (`existing` | `same_file` | `auto_created` | `unassigned`)
- Row-level errors and warnings inline; header-level counts at the top.

Confirm runs rows sequentially with per-row try/catch. Failures write to `import_items.messages` and are counted; the run continues. A "Download failed rows" button on the report screen exports the original row + error column.

## Import history & undo

- History list already exists (`import_jobs`); extend with the new fields: `duplicate_strategy`, `missing_parent_project`, `missing_parent_building`, `auto_created_projects`, `auto_created_buildings`.
- Undo: each write appended to `import_items` gets an `undo_op` (`delete <crm_id>` for creates, `patch <crm_id> <prev_snapshot>` for updates). Job detail gets an "Undo this import" button that walks items in reverse. Only the most recent successful job per scope is undoable to keep semantics safe.

## Backwards compatibility

- The current 30-column template remains as a one-click preset ("Kleegr full-hierarchy template") that pre-fills the mapping and choices exactly as today.
- The existing rollup recompute stays unit-driven and is unchanged.

## Technical details

- `src/lib/import/detect.server.ts` (new) — header sniffer returning `{ scopes: Array<"project"|"building"|"unit">, suggestedMap }`.
- `src/lib/import/mapping.ts` (new, client-safe) — canonical field dictionaries + alias table + `applyMapping(rows, map)`.
- `src/lib/import/validate.server.ts` — rewritten around the new mapping instead of the fixed 30 columns; produces the same `ValidationResult` shape so `import_items` reuse works.
- `src/lib/import/resolve.server.ts` (new) — parent resolution ladder + duplicate lookup + auto-create.
- `src/lib/import/execute.server.ts` — dispatches per-row `create` / `update` / `skip` / `create_duplicate` / `auto_create_parent`, writes `undo_op`, and returns the counts the report screen shows.
- `src/lib/import.functions.ts` — `uploadAndDetect`, `saveMapping`, `previewImport`, `confirmImport`, `undoImport`, `downloadFailedRows`.
- Migration adds columns to `import_jobs` (`duplicate_strategy`, `missing_parent_project`, `missing_parent_building`, `auto_created_projects`, `auto_created_buildings`) and to `import_items` (`resolution`, `parent_resolution`, `undo_op jsonb`).
- `src/routes/_authenticated/import/index.tsx` — replaced by a stepper (Upload → Detect → Map → Options → Preview → Confirm). `import/$jobId.tsx` gains Undo + Download failed rows.

## Out of scope for this pass

- Background job runner for huge files (spec calls it out; today runs are inline). Progress bar is shown per row but the request still resolves synchronously; if files exceed ~5k rows we'll follow up with a queue.
- Editing already-existing records in bulk from CRM exports without a chosen duplicate key — user must pick a key.
