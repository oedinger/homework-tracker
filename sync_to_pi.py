#!/usr/bin/env python3
"""Sync the homework sheet's current week tab -> Pi homework site.

Reads the newest "שבוע ..." tab of the homework sheet, builds tasks.json,
copies it to the Pi and imports it into the homework DB (done-state is
preserved by (child, title); the sheet's own "בוצע" also marks done).
"""
import hashlib
import json
import re
import subprocess
import sys
from datetime import date

SPREADSHEET_ID = "1nqAzzbtJmx_4R38BLfmDaGSBEf3iBS_pEMB2RjobFTU"
GWS = "/opt/hatch/bin/hatch_gws_cli"
OUT = "/home/hatch/workspace/homework-build/tasks.json"


def gws(args):
    r = subprocess.run([GWS] + args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"gws {' '.join(args)} failed: {r.stderr[:500]}")
    return json.loads(r.stdout)


def school_year(month):
    # School year 2026-27: Sep-Dec -> 2026, Jan-Aug -> 2027.
    return 2026 if month >= 9 else 2027


def newest_week_tab():
    meta = gws(["sheets", "spreadsheets", "get", "--params",
                json.dumps({"spreadsheetId": SPREADSHEET_ID,
                            "fields": "sheets(properties(title))"})])
    best = None
    for s in meta.get("sheets", []):
        title = s["properties"]["title"]
        m = re.search(r"(\d{1,2})[–\-](\d{1,2})\.(\d{1,2})", title)
        if not m or not title.startswith("שבוע"):
            continue
        d1, d2, mo = int(m.group(1)), int(m.group(2)), int(m.group(3))
        key = (school_year(mo), mo, d1)
        if best is None or key > best[0]:
            best = (key, title)
    if not best:
        raise RuntimeError("no week tab found")
    return best[1]


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
        tid = "t-" + hashlib.sha1(
            f"{child}|{week}|{title}".encode("utf-8")).hexdigest()[:12]
        tasks.append({
            "id": tid,
            "child": child,
            "subject": cells[6].strip(),      # נושא
            "kind": cells[5].strip(),         # שיעור: בית ספר / חוג / בית
            "title": title,
            "due": cells[2].strip(),
            "due_iso": parse_due_iso(cells[2]),
            "given": cells[3].strip(),
            "source": cells[7].strip(),
            "links": parse_links(cells[0]),
            "done": cells[1].strip() == "בוצע",
        })
    return {"week": week, "updated": date.today().isoformat(), "tasks": tasks}


def pi_run(cmd):
    r = subprocess.run(
        ["bash", "-c", f"source ~/.ssh/pi-ssh-env && pi_ssh {cmd!r}"],
        capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"pi_ssh failed: {r.stdout[-500:]} {r.stderr[-500:]}")
    return r.stdout


def main():
    week = newest_week_tab()
    payload = build_tasks(week)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    n_d = sum(1 for t in payload["tasks"] if t["child"] == "daniel")
    n_n = sum(1 for t in payload["tasks"] if t["child"] == "naya")
    # copy to Pi and import
    r = subprocess.run(
        ["bash", "-c",
         "source ~/.ssh/pi-ssh-env && "
         f"pi_scp {OUT} oedinger@ssh.oedinger.stream:~/homework/tasks.json"],
        capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"pi_scp failed: {r.stderr[-500:]}")
    pi_run("python3 ~/homework/import_tasks.py")
    print(f"synced week {week}: daniel={n_d} naya={n_n} total={len(payload['tasks'])}")


if __name__ == "__main__":
    main()
