# homework-tracker

Kids' homework tracker for the Edinger family — weekly homework sheet
("שיעורי בית — ילדים") surfaced as a website at
https://homework.oedinger.stream, with a per-day school schedule tab
("מערכת שעות").

## How it works

- **Cloudflare Worker + KV** (Worker `homework-tracker`, KV `homework`,
  route `homework.oedinger.stream/*`). No Pi, no D1.
- Every 2h (Sun–Thu 08:00–20:00, Fri 08:00–16:00, Sat 08:00+18:00) a
  pipeline scans WebTop + the family homework WhatsApp group (+ class
  groups) and updates the Google Sheet, then syncs to the site.
- `index.html` — the site (homework + schedule tabs, per-child filter,
  break boxes between lessons, "עכשיו" highlight).
- `worker.js` — the deployed Worker (built from `worker_template.js` by
  `build_worker.py`).
- `server.py` — local dev server.
- `sync_to_cloud.py` / `sync_to_pi.py` — sync helpers.
- `import_tasks.py` — import tasks into the sheet.
- `cloudflared.yml`, `homework.service`, `homework-tunnel.service` — tunnel
  and service definitions.
- `worker_meta.json` — Worker metadata.

## Not in this repo

- `tasks.json` — runtime data, changes every 2h (excluded).
- `.sync-secret` — bearer secret for the sync endpoint (excluded, never
  commit it).

## Workflow (Pi)

All GitHub work for this repo runs from the Pi: edit in ~/github/homework-tracker, commit and push with git over SSH (pi-backup key). Pushes from the Pi need no Muse approval card.
