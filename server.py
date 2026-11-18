#!/usr/bin/env python3
"""Kids homework tracker — stdlib-only HTTP server + SQLite.

Serves the homework page on 127.0.0.1:8081 (exposed via the Cloudflare
tunnel as homework.oedinger.stream). Tasks come from tasks.json (synced
daily from the Google Sheet); done-state lives in homework.db and is
shared between all visitors.
"""
import json
import os
import sqlite3
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "homework.db")
TASKS_JSON = os.path.join(BASE, "tasks.json")
INDEX_HTML = os.path.join(BASE, "index.html")


def connect():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def ensure_schema(c):
    c.execute("""CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, child TEXT, subject TEXT, title TEXT,
        due TEXT, due_iso TEXT, given_date TEXT, source TEXT,
        links TEXT, week TEXT, done INTEGER DEFAULT 0, updated_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT)""")
    try:
        c.execute("ALTER TABLE tasks ADD COLUMN kind TEXT DEFAULT ''")
    except Exception:
        pass  # column already exists


def init_db():
    c = connect()
    ensure_schema(c)
    n = c.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    c.commit()
    c.close()
    if n == 0:
        import_tasks()


def import_tasks(path=TASKS_JSON):
    """Replace the task set from tasks.json, preserving done-state.

    Done is preserved by (child, title) across weeks, and OR-ed with the
    sheet's own done flag (column B == "בוצע"), so a task marked done in
    either place stays done. Tasks absent from the new set disappear
    (done tasks never carry over to the next week).
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    c = connect()
    ensure_schema(c)
    prev = {(r["child"], r["title"]): r["done"]
            for r in c.execute("SELECT child,title,done FROM tasks")}
    c.execute("DELETE FROM tasks")
    for t in data["tasks"]:
        done = 1 if (t.get("done") or prev.get((t["child"], t["title"]))) else 0
        c.execute("""INSERT INTO tasks
            (id,child,subject,kind,title,due,due_iso,given_date,source,links,week,done)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (t["id"], t["child"], t["subject"], t.get("kind", ""), t["title"],
             t.get("due", ""), t.get("due_iso", ""), t.get("given", ""),
             t.get("source", ""),
             json.dumps(t.get("links", []), ensure_ascii=False), data["week"],
             done))
    c.execute("INSERT OR REPLACE INTO meta (key,value) VALUES ('week',?)",
              (data["week"],))
    c.execute("INSERT OR REPLACE INTO meta (key,value) VALUES ('updated',?)",
              (data.get("updated", ""),))
    c.commit()
    c.close()


def all_tasks():
    c = connect()
    rows = c.execute("SELECT * FROM tasks ORDER BY child, done, due_iso").fetchall()
    meta = {r["key"]: r["value"] for r in c.execute("SELECT * FROM meta").fetchall()}
    c.close()
    tasks = []
    for r in rows:
        d = dict(r)
        d["links"] = json.loads(d["links"] or "[]")
        d["done"] = bool(d["done"])
        tasks.append(d)
    return {"week": meta.get("week", ""), "updated": meta.get("updated", ""),
            "tasks": tasks}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(INDEX_HTML, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/tasks":
            self._send_json(all_tasks())
        elif self.path == "/health":
            self._send_json({"ok": True})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "tasks" and parts[3] == "done":
            task_id = parts[2]
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                payload = {}
            done = 1 if payload.get("done") else 0
            c = connect()
            cur = c.execute(
                "UPDATE tasks SET done=?, updated_at=datetime('now') WHERE id=?",
                (done, task_id))
            c.commit()
            if cur.rowcount == 0:
                c.close()
                self._send_json({"error": "not found"}, 404)
                return
            row = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            c.close()
            d = dict(row)
            d["links"] = json.loads(d["links"] or "[]")
            d["done"] = bool(d["done"])
            self._send_json(d)
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    init_db()
    ThreadingHTTPServer(("127.0.0.1", 8081), H).serve_forever()
