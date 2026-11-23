#!/usr/bin/env python3
"""Sync the homework sheet's current week tab -> Cloudflare Worker.

Same sheet parsing as sync_to_pi.py, but the payload is POSTed to the
Worker's /api/sync endpoint (Bearer secret from .sync-secret) instead of
being copied to the Pi. The Worker preserves done-state by (child, title)
and ORs the sheet's own "בוצע" flags.
"""
import hashlib
import json
import re
import subprocess
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

SPREADSHEET_ID = "1nqAzzbtJmx_4R38BLfmDaGSBEf3iBS_pEMB2RjobFTU"
GWS = "/opt/hatch/bin/hatch_gws_cli"
OUT = "/home/hatch/workspace/homework-build/tasks.json"
SECRET_FILE = "/home/hatch/workspace/homework-build/.sync-secret"
SYNC_URL = "https://homework.oedinger.stream/api/sync"
PULLS_FILE = "/home/hatch/workspace/goals/goal-13/hidden_files/source-pulls.json"


def read_pulls():
    """Last successful pull times per source (whatsapp/webtop), maintained
    by the site-sync crons from the pull jobs' run history. Missing file or
    keys -> empty strings (the page hides those lines)."""
    try:
        with open(PULLS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def gws(args):
    r = subprocess.run([GWS] + args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"gws {' '.join(args)} failed: {r.stderr[:500]}")
    return json.loads(r.stdout)


def school_year(month):
    return 2026 if month >= 9 else 2027


def list_week_tabs():
    """All 'שבוע ...' tabs, oldest first: [(sort_key, title)]."""
    meta = gws(["sheets", "spreadsheets", "get", "--params",
                json.dumps({"spreadsheetId": SPREADSHEET_ID,
                            "fields": "sheets(properties(title))"})])
    out = []
    for s in meta.get("sheets", []):
        title = s["properties"]["title"]
        m = re.search(r"(\d{1,2})[–\-](\d{1,2})\.(\d{1,2})", title)
        if not m or not title.startswith("שבוע"):
            continue
        d1, d2, mo = int(m.group(1)), int(m.group(2)), int(m.group(3))
        out.append(((school_year(mo), mo, d1), title))
    out.sort()
    return out


def newest_week_tab():
    tabs = list_week_tabs()
    if not tabs:
        raise RuntimeError("no week tab found")
    return tabs[-1][1]


def parse_links(raw):
    raw = (raw or "").strip()
    if not raw:
        return []
    m = re.match(r'=HYPERLINK\("([^"]+)","([^"]*)"\)', raw)
    if m:
        return [{"label": m.group(2) or "📎 קובץ", "url": m.group(1)}]
    urls = [l.strip() for l in raw.splitlines() if "http" in l]
    out = []
    for i, u in enumerate(urls, 1):
        label = f"Wordwall {i}" if "wordwall" in u else f"קישור {i}"
        out.append({"label": label, "url": u})
    return out


def parse_due_iso(due):
    m = re.search(r"(\d{1,2})/(\d{1,2})", due or "")
    if not m:
        return ""
    d, mo = int(m.group(1)), int(m.group(2))
    return f"{school_year(mo)}-{mo:02d}-{d:02d}"


def split_title(title):
    """Short card title + full details text.

    Titles are usually "Short title — rest of the description" (em dash) or
    "Short title: rest" (colon). Without a separator the whole title is the
    short title and the details area shows only the meta (given/source).
    """
    for sep in (" — ", " – ", ": "):
        i = title.find(sep)
        if i > 0:
            return title[:i].strip(), title[i + len(sep):].strip()
    return title, ""


def build_tasks(week):
    data = gws(["sheets", "spreadsheets", "values", "get", "--params",
                json.dumps({"spreadsheetId": SPREADSHEET_ID,
                            "range": f"{week}!A1:H80",
                            "valueRenderOption": "FORMULA"})])
    rows = data.get("values", [])
    tasks = []
    child = None
    for r in rows:
        cells = (r + [""] * 8)[:8]
        joined = " ".join(cells)
        if "דניאל" in joined and "🔵" in joined:
            child = "daniel"
            continue
        if "נאיה" in joined and "🩷" in joined:
            child = "naya"
            continue
        title = cells[4].strip()
        if not title or title == "מטלה" or child is None:
            continue
        # The id must distinguish repeated instances of a recurring title
        # within one week: the same title can be given again (e.g. Naya's
        # weekly "סיפור לשבת") while the previous instance is still open,
        # so both rows sit in the same week tab. Including the given date
        # (falling back to the due date) gives each instance its own id;
        # without it the two rows collide and share one done flag.
        given_iso = parse_due_iso(cells[3])
        due_iso = parse_due_iso(cells[2])
        date_key = given_iso or due_iso
        tid = "t-" + hashlib.sha1(
            f"{child}|{week}|{title}|{date_key}".encode("utf-8")).hexdigest()[:12]
        short, details = split_title(title)
        tasks.append({
            "id": tid,
            "child": child,
            "subject": cells[6].strip(),
            "kind": cells[5].strip(),
            "title": title,
            "short": short,
            "details": details,
            "due": cells[2].strip(),
            "due_iso": due_iso,
            "given": cells[3].strip(),
            "given_iso": given_iso,
            "source": cells[7].strip(),
            "links": parse_links(cells[0]),
            "done": cells[1].strip() == "בוצע",
        })
    now_il = datetime.now(ZoneInfo("Asia/Jerusalem"))
    pulls = read_pulls()
    return {"week": week, "updated": now_il.isoformat(timespec="minutes"),
            "last_whatsapp": pulls.get("whatsapp", ""),
            "last_webtop": pulls.get("webtop", ""), "tasks": tasks}


def _urlopen_with_retries(req, attempts=4):
    """urlopen with retries: the VM->Cloudflare path sometimes truncates a
    response (IncompleteRead / RemoteDisconnected) even when the server
    applied the request."""
    import time
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception as e:  # noqa: BLE001 - transport flakes, retry
            last = e
            time.sleep(2 * (i + 1))
    raise last


def curl_get_json(url):
    """GET JSON via curl. Python urllib consistently gets truncated
    responses (IncompleteRead/RemoteDisconnected) from the Cloudflare
    Worker on this VM->Cloudflare path — the ~20KB state body is cut
    mid-read every time — while curl returns the full body. Used for
    the post-sync verification read-back (the POST itself is small
    and works fine over urllib)."""
    r = subprocess.run(
        ["curl", "-s", "-m", "60", "-A",
         "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/120.0 Safari/537.36", url],
        capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        raise RuntimeError(f"curl GET failed rc={r.returncode}: {r.stderr[:200]}")
    return json.loads(r.stdout)


def post_sync(payload, verify_week=None):
    """POST the payload; the edge sometimes drops the response even when the
    Worker applied it, so verify by reading the state back. KV reads lag
    writes by a few seconds, so poll until the week shows up."""
    secret = open(SECRET_FILE).read().strip()
    headers = {"Content-Type": "application/json",
               "Authorization": "Bearer " + secret,
               # Cloudflare's edge blocks Python-urllib's default UA (403);
               # send a browser UA.
               "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
    req = urllib.request.Request(
        SYNC_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers, method="POST")
    result = None
    try:
        result = json.loads(_urlopen_with_retries(req))
    except Exception as e:
        result = {"ok": None, "post_error": repr(e)[:120]}
    # Verify from the live state (poll — KV reads lag the write).
    import time
    want_week = verify_week or payload["week"]
    get_url = (SYNC_URL.replace("/api/sync", "/api/tasks")
               + "?week=" + urllib.parse.quote(want_week))
    for _ in range(6):
        try:
            state = curl_get_json(get_url)
        except Exception:
            state = {}
        if (state.get("week") == want_week
                and len(state.get("tasks", [])) == len(payload["tasks"])):
            if result.get("ok") is None:
                result = {"ok": True, "count": len(payload["tasks"]),
                          "week": want_week, "verified_by_poll": True}
            return result
        time.sleep(3)
    raise RuntimeError(
        f"sync POST result={result} but live state for {want_week} "
        f"does not match ({len(payload['tasks'])} tasks expected)")


def main():
    import sys
    if "--backfill" in sys.argv:
        backfill()
        return
    week = newest_week_tab()
    payload = build_tasks(week)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    result = post_sync(payload)
    n_d = sum(1 for t in payload["tasks"] if t["child"] == "daniel")
    n_n = sum(1 for t in payload["tasks"] if t["child"] == "naya")
    print(f"synced week {week}: daniel={n_d} naya={n_n} "
          f"total={len(payload['tasks'])} server={result}")


def backfill():
    """Sync every week tab, oldest first, so the Worker can compute
    carried/new against the previous week and the site gets a real week
    history. Empty tabs (e.g. the template) are skipped."""
    tabs = list_week_tabs()
    for _, week in tabs:
        payload = build_tasks(week)
        if not payload["tasks"]:
            print(f"skip {week}: no tasks")
            continue
        result = post_sync(payload)
        print(f"synced week {week}: total={len(payload['tasks'])} "
              f"server={result}")
        if week == tabs[-1][1]:
            with open(OUT, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
