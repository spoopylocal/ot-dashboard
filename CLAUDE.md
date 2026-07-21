# CLAUDE.md — working notes for this repo

## Git / PR workflow (IMPORTANT)
When working on the OT Dashboard:
- Do the work on a feature branch cut from `ot-dashboard`, then **commit and push** it.
- **Do NOT open a pull request.** The maintainer creates the PR to merge into `main` manually.
- Only open a PR if explicitly asked to.
- `ot-dashboard` is the shared integration branch (multiple people build off it);
  `main` is what Netlify deploys. Prefer one-way flow: features → `ot-dashboard`,
  then `ot-dashboard` → `main` for releases.

## What this project is
Single-file warehouse **OT (outbound) tracker** — a React app deployed as one
`index.html`, maintained as unpacked sources plus a build step.

## Build
- Edit sources in `src/` (`app_logic.js`, `template.html`, `data.js`).
- Run `node build.js` to regenerate `index.html` (injects data + logic into the
  template, then repacks into `shell.html`'s bundle block). The build does a
  round-trip integrity check and fails loudly if the output is corrupt.
- Always rebuild and commit `index.html` alongside `src/` changes.
- Local preview: `npx http-server -p 8123 -c-1 .` then open http://localhost:8123
  (must be served over HTTP, not opened as a file).

## Live sync
- Edits live in the shared Supabase `ot_edits` table (not in `data.js`, which is
  only the seed layout). Realtime WebSocket + REST resync (on focus/visibility/
  online + 45s poll); falls back to localStorage if Supabase can't load.
- Row freshness is decided by local-write windows + content equality, **not** by
  comparing `updated_at` across machines (cross-clock skew caused stale rows that
  needed a page refresh — fixed).
- Version backups + runtime config live as `__`-prefixed meta rows in the same
  table and are excluded from location handling.

## Admin panel
- Shift+B (outside a text field) opens it; password `wwtadmin`
  (`ADMIN_PW_HASH` in `src/app_logic.js`, client-side gate only).
- Sections: version history (backups/restore), statuses, locations, fields.
