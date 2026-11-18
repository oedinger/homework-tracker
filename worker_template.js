// Homework tracker — Cloudflare Worker + KV (multi-week model).
// KV keys:
//   week:<week name> -> {week, updated, tasks: [...]}
//   meta             -> {weeks: [...chronological...], current: "<week name>"}
// Legacy key "state" (single-week doc from the first deployment) is merged
// once, when its week is synced, then deleted.
// Task flags, computed at sync time:
//   carried — the task (same child + title) was in the previous week's list
//   is_new  — it was not (added this week)
//   done    — sheet "בוצע" OR the site's own checkmark (preserved per week,
//             and carried forward for carried tasks)
// Routes: GET / (page), GET /api/weeks, GET /api/tasks[?week=],
// POST /api/tasks/:id/done[?week=],
// POST /api/sync (Bearer SYNC_SECRET — upserts one week, keeps meta current).
//
// NOTE: D1 was not available — the API token has no D1 scope (401 on every
// D1 call). KV covers this app fully: small documents, read often, written
// rarely. KV reads are eventually consistent (a fresh write can take up to
// ~20s to show from another edge location).

const HTML = __HTML_JSON__;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const weekKey = (week) => 'week:' + week;

function weekOrder(week) {
  const m = String(week).match(/(\d{1,2})[–\-](\d{1,2})\.(\d{1,2})/);
  if (!m) return 0;
  const d1 = parseInt(m[1], 10);
  const mo = parseInt(m[3], 10);
  const y = mo >= 9 ? 2026 : 2027;
  return y * 10000 + mo * 100 + d1;
}

async function getMeta(env) {
  const meta = await env.HOMEWORK_KV.get('meta', 'json');
  return meta || { weeks: [], current: '' };
}

async function getWeek(env, week) {
  const doc = await env.HOMEWORK_KV.get(weekKey(week), 'json');
  return doc || { week, updated: '', tasks: [] };
}

async function getCurrentDoc(env) {
  const meta = await getMeta(env);
  if (meta.current) return getWeek(env, meta.current);
  const legacy = await env.HOMEWORK_KV.get('state', 'json');
  return legacy || { week: '', updated: '', tasks: [] };
}

function findTask(doc, child, title) {
  if (!doc) return null;
  return doc.tasks.find((t) => t.child === child && t.title === title) || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/health') return json({ ok: true });

    if (path === '/api/weeks' && request.method === 'GET') {
      return json(await getMeta(env));
    }

    if (path === '/api/tasks' && request.method === 'GET') {
      const week = url.searchParams.get('week');
      return json(week ? await getWeek(env, week) : await getCurrentDoc(env));
    }

    const doneMatch = path.match(/^\/api\/tasks\/([^/]+)\/done$/);
    if (doneMatch && request.method === 'POST') {
      const id = decodeURIComponent(doneMatch[1]);
      const week = url.searchParams.get('week');
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const doc = week ? await getWeek(env, week) : await getCurrentDoc(env);
      if (!doc.week) return json({ error: 'no such week' }, 404);
      const task = doc.tasks.find((t) => t.id === id);
      if (!task) return json({ error: 'not found' }, 404);
      task.done = !!body.done;
      await env.HOMEWORK_KV.put(weekKey(doc.week), JSON.stringify(doc));
      return json(task);
    }

    if (path === '/api/sync' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.SYNC_SECRET) {
        return new Response('unauthorized', { status: 401 });
      }
      const data = await request.json();
      const week = data.week;
      const meta = await getMeta(env);
      const legacy = await env.HOMEWORK_KV.get('state', 'json');

      // Same-week doc (for done + flag preservation on re-sync).
      let sameDoc = await env.HOMEWORK_KV.get(weekKey(week), 'json');
      if (!sameDoc && legacy && legacy.week === week) sameDoc = legacy;

      // Previous-week doc (for carried/new computation): the latest stored
      // week strictly earlier than this one; the legacy doc counts if it is
      // earlier and no stored week is.
      let prevDoc = null;
      const earlier = meta.weeks.filter((w) => weekOrder(w) < weekOrder(week));
      if (earlier.length) {
        earlier.sort((a, b) => weekOrder(a) - weekOrder(b));
        prevDoc = await getWeek(env, earlier[earlier.length - 1]);
      } else if (legacy && weekOrder(legacy.week) < weekOrder(week)) {
        prevDoc = legacy;
      }

      let carried = 0;
      let isNew = 0;
      const tasks = (data.tasks || []).map((t) => {
        const same = findTask(sameDoc, t.child, t.title);
        const prev = findTask(prevDoc, t.child, t.title);
        const c = same ? !!(same.carried ?? !!prev) : !!prev;
        const n = same ? !!(same.is_new ?? !c) : !c;
        const done = !!(t.done || (same && same.done) || (c && prev && prev.done));
        if (c) carried += 1; else isNew += 1;
        return { ...t, carried: c, is_new: n, done };
      });

      const doc = {
        week,
        updated: data.updated || '',
        last_whatsapp: data.last_whatsapp || (sameDoc && sameDoc.last_whatsapp) || '',
        last_webtop: data.last_webtop || (sameDoc && sameDoc.last_webtop) || '',
        tasks,
      };
      await env.HOMEWORK_KV.put(weekKey(week), JSON.stringify(doc));
      if (!meta.weeks.includes(week)) meta.weeks.push(week);
      meta.weeks.sort((a, b) => weekOrder(a) - weekOrder(b));
      meta.current = week;
      await env.HOMEWORK_KV.put('meta', JSON.stringify(meta));
      if (legacy && legacy.week === week) {
        await env.HOMEWORK_KV.delete('state');
      }
      return json({ ok: true, count: tasks.length, week, carried, new: isNew });
    }

    return new Response('Not found', { status: 404 });
  },
};
