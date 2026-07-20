# WWT OT Tracker

Single-file warehouse outbound tracker (React + Supabase live sync), unpacked
into editable sources with a build step that repacks everything into the
deployable `index.html`.

## Layout

| File | What it is | Edit it? |
|---|---|---|
| `src/app_logic.js` | The app component: state, filters, table editing, Supabase sync, presence | **Yes — most edits go here** |
| `src/template.html` | The markup and CSS (WWT design tokens, dashboard, map, table) | Yes |
| `src/data.js` | Seed dataset (`window.__OT_DATA` — 134 locations, 8 zones, linkouts) | Yes |
| `shell.html` | The original bundle: fonts, React, and the loader. Carrier for the build | No — never by hand |
| `index.html` | **Build output.** The single file you deploy/share | No — regenerate it |
| `build.js` | Reassembles `index.html` from `shell.html` + `src/` | Only to change the build |

`src/template.html` contains two markers — `/*__OT_DATA__*/` and
`/*__APP_LOGIC__*/` — where `data.js` and `app_logic.js` are injected at
build time. Don't remove them.

## Workflow

1. Edit the files in `src/`.
2. Rebuild:

   ```
   node build.js
   ```

3. Preview locally (the app must be served over HTTP, not opened as a file):

   ```
   npx http-server -p 8123 -c-1 .
   ```

   then open http://localhost:8123. (`.claude/launch.json` starts this same
   server from Claude Code.)

4. Deploy/share the regenerated `index.html`.

The build round-trip-checks its own output and fails loudly rather than
producing a corrupt file.

## Versioning & Admin panel

- **Auto backups**: while the tracker is open in any browser, it checks ~10 s
  after load and then every 30 minutes. If the data changed since the last
  version (hash compare), it saves a new snapshot. No change → no new version.
  A restore also saves a "Pre-restore safety copy" first, so restores are
  always undoable.
- **Where versions live**: in the same `ot_edits` Supabase table, as rows
  keyed `__backup__<timestamp>`. The app ignores `__`-prefixed rows
  everywhere it deals with locations. If you read `ot_edits` from an outside
  integration, filter them out with `?ot=not.like.__backup*`.
- **Admin panel**: press **Shift+B** (outside a text field) to open it.
  Password: `wwtadmin` — change it by editing `ADMIN_PW_HASH` in
  [src/app_logic.js](src/app_logic.js); the comment above the constant has the
  one-liner that computes a new hash. It's a client-side gate: it deters
  casual users, not someone reading the source.
- **In the panel**: create labeled manual saves, view any version (shows
  which locations differ from current data, field by field), restore a
  version (overwrites the live table; locations absent from the snapshot are
  cleared), and delete versions (two-click confirm).
- **Enable deletes**: the `ot_edits` RLS policy currently allows
  select/insert/update but not delete, so version deletion is blocked (the
  panel tells you when that happens). To enable it, run this in the Supabase
  SQL editor — it only permits deleting backup rows, never live locations:

  ```sql
  create policy "allow deleting backup rows" on public.ot_edits
    for delete using (ot like '\_\_backup\_\_%');
  ```

## Notes

- Live edits (work orders, serials, statuses, notes) are stored in the
  `ot_edits` Supabase table, not in `data.js` — `data.js` is only the seed
  layout of locations/zones. The Supabase URL/key live in `src/app_logic.js`.
- The Supabase client is loaded from jsDelivr at runtime, so the live-sync
  features need internet access; without it the app falls back to
  localStorage-only edits.
- A `sku` tab is scaffolded in the logic (`showSku`) but not registered in
  the tab bar — only the tracker tab is exposed.
