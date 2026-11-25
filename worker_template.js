// Homework tracker — Cloudflare Worker + KV (multi-week model).
// KV keys:
//   week:<week name> -> {week, updated, tasks: [...]}
//   meta             -> {weeks: [...chronological...], current: "<week name>"}
//   reminders          -> [{id, text, date, time, child, done, created,
//                           createdBy, owner, seen, seenAt, notified, background,
//                           comments: [{id, by, text, created}]}]
//     child: "all" | "daniel" | "naya" | "ben" | "alin";
//     createdBy/owner: "oren" | "lior". Old entries without the new fields
//     are treated as createdBy=owner="oren", seen=false, notified=false.
//   feature-requests   -> [{id, type, text, by, status, created, updated,
//                              comments: [{id, by, text, created}]}]
//     type: "feature" | "bug"; by: "oren" | "lior" (only these two may ask);
//     status: "open" | "in_progress" | "done" | "needs_info".
// Legacy key "state" (single-week doc from the first deployment) is merged
// once, when its week is synced, then deleted.
// Task flags, computed at sync time:
//   carried — the task (same child + title) was in the previous week's list
//   is_new  — it was not (added this week)
//   done    — sheet "בוצע" OR the site's own checkmark (preserved per week,
//             and carried forward for carried tasks). Done is preserved per
//             task INSTANCE: matching is by child + title + given date, so
//             two instances of one recurring title keep separate flags
//             (see findTask). Task ids in the sync payload include the
//             given date for the same reason.
// Routes: GET / (page), GET /api/weeks, GET /api/tasks[?week=],
// POST /api/tasks/:id/done[?week=],
// GET /api/reminders, POST /api/reminders, PATCH /api/reminders/:id,
// POST /api/reminders/:id/done, POST /api/reminders/:id/seen,
// POST /api/reminders/:id/notify (Bearer SYNC_SECRET),
// POST /api/reminders/:id/comments,
// DELETE /api/reminders/:id,
// GET /api/requests, POST /api/requests,
// POST /api/requests/:id/comments,
// POST /api/requests/:id/status (Bearer SYNC_SECRET),
// DELETE /api/requests/:id (Bearer SYNC_SECRET),
// POST /api/sync (Bearer SYNC_SECRET — upserts one week, keeps meta current).
//
// NOTE: D1 was not available — the API token has no D1 scope (401 on every
// D1 call). KV covers this app fully: small documents, read often, written
// rarely. KV reads are eventually consistent (a fresh write can take up to
// ~20s to show from another edge location).

const HTML = __HTML_JSON__;
const HTML_NEW = __HTML_NEW_JSON__;

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

function findTask(doc, child, title, givenIso) {
  if (!doc) return null;
  // Match one specific instance of a title: the same title can appear
  // twice in one week (a recurring task re-given while the previous
  // instance is still open), and the two rows must keep separate done
  // flags. The given date disambiguates them.
  if (givenIso) {
    const exact = doc.tasks.find(
      (t) => t.child === child && t.title === title && (t.given_iso || '') === givenIso);
    if (exact) return exact;
  }
  // Fallback for rows with no given date: only unambiguous when the
  // title occurs once in this doc; otherwise return null so no done
  // state leaks from one instance to another.
  const matches = doc.tasks.filter((t) => t.child === child && t.title === title);
  return matches.length === 1 ? matches[0] : null;
}

// ---- shared reminders (KV key "reminders", one array, max 200) ----
async function getReminders(env) {
  return (await env.HOMEWORK_KV.get('reminders', 'json')) || [];
}
async function putReminders(env, list) {
  await env.HOMEWORK_KV.put('reminders', JSON.stringify(list.slice(-200)));
}
function reminderId() {
  return 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function remCommentId() {
  return 'rc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
const REM_CHILDREN = ['all', 'daniel', 'naya', 'ben', 'alin'];
const isPerson = (v) => v === 'oren' || v === 'lior';
// Backward compatibility: old reminders lack createdBy/owner/seen/seenBy/
// notified/remindedDay/remindedHour.
function normReminder(r) {
  return {
    ...r,
    createdBy: isPerson(r.createdBy) ? r.createdBy : 'oren',
    owner: isPerson(r.owner) ? r.owner : 'oren',
    seen: !!r.seen,
    seenAt: r.seenAt || null,
    seenBy: isPerson(r.seenBy) ? r.seenBy : null,
    notified: !!r.notified,
    remindedDay: !!r.remindedDay,
    remindedHour: !!r.remindedHour,
    background: typeof r.background === 'string' ? r.background.slice(0, 1000) : '',
    comments: Array.isArray(r.comments)
      ? r.comments.filter((c) => c && typeof c.text === 'string').map((c) => ({
          id: c.id || remCommentId(),
          by: isPerson(c.by) ? c.by : 'oren',
          text: String(c.text).slice(0, 500),
          created: c.created || '',
        }))
      : [],
  };
}

// ---- feature requests / bug reports (KV key "feature-requests") ----
async function getRequests(env) {
  return (await env.HOMEWORK_KV.get('feature-requests', 'json')) || [];
}
async function putRequests(env, list) {
  await env.HOMEWORK_KV.put('feature-requests', JSON.stringify(list.slice(0, 100)));
}
function requestId() {
  return 'fr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function commentId() {
  return 'fc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// Backward compatibility: old requests lack comments.
function normRequest(r) {
  return {
    ...r,
    comments: Array.isArray(r.comments)
      ? r.comments.filter((c) => c && typeof c.text === 'string').map((c) => ({
          id: c.id || commentId(),
          by: isPerson(c.by) ? c.by : 'oren',
          text: String(c.text).slice(0, 500),
          created: c.created || '',
        }))
      : [],
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      // New design is the default. The old design is served only on ?design=old.
      const html = url.searchParams.get('design') === 'old' ? HTML : HTML_NEW;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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

    // ---- reminders ----
    if (path === '/api/reminders' && request.method === 'GET') {
      return json({ reminders: (await getReminders(env)).map(normReminder) });
    }
    if (path === '/api/reminders' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const text = String(body.text || '').trim().slice(0, 200);
      const date = String(body.date || '');
      const time = String(body.time || '');
      if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return json({ error: 'text, date (YYYY-MM-DD) and time (HH:MM) are required' }, 400);
      }
      const child = REM_CHILDREN.includes(body.child) ? body.child : 'all';
      const createdBy = isPerson(body.createdBy) ? body.createdBy : 'oren';
      const owner = isPerson(body.owner) ? body.owner : 'oren';
      const background = String(body.background ?? '').trim();
      if (background.length > 1000) {
        return json({ error: 'background must be at most 1000 chars' }, 400);
      }
      const reminder = {
        id: reminderId(), text, date, time, child, done: false,
        created: new Date().toISOString(),
        createdBy, owner, background, seen: false, seenAt: null, seenBy: null,
        notified: false, remindedDay: false, remindedHour: false,
        comments: [],
      };
      const list = await getReminders(env);
      list.push(reminder);
      await putReminders(env, list);
      return json({ reminder }, 201);
    }
    const remDoneMatch = path.match(/^\/api\/reminders\/([^/]+)\/done$/);
    if (remDoneMatch && request.method === 'POST') {
      const id = decodeURIComponent(remDoneMatch[1]);
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const list = await getReminders(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      r.done = !!body.done;
      await putReminders(env, list);
      return json(r);
    }
    const remPatchMatch = path.match(/^\/api\/reminders\/([^/]+)$/);
    if (remPatchMatch && request.method === 'PATCH') {
      const id = decodeURIComponent(remPatchMatch[1]);
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const list = await getReminders(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      const nr = normReminder(r);
      if (body.text !== undefined) {
        const text = String(body.text || '').trim().slice(0, 200);
        if (!text) return json({ error: 'text must not be empty' }, 400);
        nr.text = text;
      }
      if (body.date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) {
          return json({ error: 'date must be YYYY-MM-DD' }, 400);
        }
        nr.date = body.date;
      }
      if (body.time !== undefined) {
        if (!/^\d{2}:\d{2}$/.test(String(body.time || ''))) {
          return json({ error: 'time must be HH:MM' }, 400);
        }
        nr.time = body.time;
      }
      if (body.child !== undefined) {
        if (!REM_CHILDREN.includes(body.child)) {
          return json({ error: 'child must be all|daniel|naya|ben|alin' }, 400);
        }
        nr.child = body.child;
      }
      if (body.background !== undefined) {
        const bg = String(body.background ?? '').trim();
        if (bg.length > 1000) {
          return json({ error: 'background must be at most 1000 chars' }, 400);
        }
        nr.background = bg;
      }
      if (body.owner !== undefined) {
        if (!isPerson(body.owner)) {
          return json({ error: 'owner must be oren|lior' }, 400);
        }
        // Reassigned to someone else: new owner must be notified + ack,
        // and gets fresh day/hour reminders too.
        if (body.owner !== nr.owner) {
          nr.owner = body.owner;
          nr.notified = false;
          nr.seen = false;
          nr.seenAt = null;
          nr.seenBy = null;
          nr.remindedDay = false;
          nr.remindedHour = false;
        }
      }
      Object.assign(r, nr);
      await putReminders(env, list);
      return json(normReminder(r));
    }
    const remSeenMatch = path.match(/^\/api\/reminders\/([^/]+)\/seen$/);
    if (remSeenMatch && request.method === 'POST') {
      const id = decodeURIComponent(remSeenMatch[1]);
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const list = await getReminders(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      const nr = normReminder(r);
      nr.seen = true;
      nr.seenAt = new Date().toISOString();
      nr.seenBy = isPerson(body.by) ? body.by : nr.owner;
      Object.assign(r, nr);
      await putReminders(env, list);
      return json(normReminder(r));
    }
    const remNotifyMatch = path.match(/^\/api\/reminders\/([^/]+)\/notify$/);
    if (remNotifyMatch && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.SYNC_SECRET) {
        return new Response('unauthorized', { status: 401 });
      }
      const id = decodeURIComponent(remNotifyMatch[1]);
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const kind = body.kind || 'assigned';
      if (!['assigned', 'day', 'hour'].includes(kind)) {
        return json({ error: 'kind must be assigned|day|hour' }, 400);
      }
      const list = await getReminders(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      const nr = normReminder(r);
      if (kind === 'assigned') nr.notified = true;
      else if (kind === 'day') nr.remindedDay = true;
      else nr.remindedHour = true;
      Object.assign(r, nr);
      await putReminders(env, list);
      return json(normReminder(r));
    }
    const remCommentMatch = path.match(/^\/api\/reminders\/([^/]+)\/comments$/);
    if (remCommentMatch && request.method === 'POST') {
      const id = decodeURIComponent(remCommentMatch[1]);
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const by = body.by === 'oren' || body.by === 'lior' ? body.by : '';
      const text = String(body.text || '').trim();
      if (!by || !text || text.length > 500) {
        return json({ error: 'by (oren|lior) and text (1-500 chars) are required' }, 400);
      }
      const list = await getReminders(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      const nr = normReminder(r);
      const comment = { id: remCommentId(), by, text, created: new Date().toISOString() };
      nr.comments.push(comment);
      Object.assign(r, nr);
      await putReminders(env, list);
      return json({ comment, reminder: normReminder(r) }, 201);
    }
    const remDelMatch = path.match(/^\/api\/reminders\/([^/]+)$/);
    if (remDelMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(remDelMatch[1]);
      const list = await getReminders(env);
      const kept = list.filter((x) => x.id !== id);
      if (kept.length === list.length) return json({ error: 'not found' }, 404);
      await putReminders(env, kept);
      return json({ ok: true });
    }

    // ---- feature requests / bug reports (KV key "feature-requests") ----
    // Only Oren and Lior may ask (enforced via `by` validation — there is
    // no login; the site is not publicized). Status changes and deletes
    // require the sync bearer secret, same as /api/sync.
    if (path === '/api/requests' && request.method === 'GET') {
      return json({ requests: (await getRequests(env)).map(normRequest) });
    }
    if (path === '/api/requests' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const type = body.type === 'bug' ? 'bug' : body.type === 'feature' ? 'feature' : '';
      const text = String(body.text || '').trim().slice(0, 500);
      const by = body.by === 'oren' || body.by === 'lior' ? body.by : '';
      if (!type || !text || !by) {
        return json({ error: 'type (feature|bug), text (1-500 chars) and by (oren|lior) are required' }, 400);
      }
      const now = new Date().toISOString();
      const req = {
        id: requestId(), type, text, by,
        status: 'open', created: now, updated: now, comments: [],
      };
      const list = await getRequests(env);
      list.unshift(req);
      await putRequests(env, list);
      return json({ request: req }, 201);
    }
    const reqCommentMatch = path.match(/^\/api\/requests\/([^/]+)\/comments$/);
    if (reqCommentMatch && request.method === 'POST') {
      const id = decodeURIComponent(reqCommentMatch[1]);
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const by = body.by === 'oren' || body.by === 'lior' ? body.by : '';
      const text = String(body.text || '').trim();
      if (!by || !text || text.length > 500) {
        return json({ error: 'by (oren|lior) and text (1-500 chars) are required' }, 400);
      }
      const list = await getRequests(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      const nr = normRequest(r);
      const comment = { id: commentId(), by, text, created: new Date().toISOString() };
      nr.comments.push(comment);
      nr.updated = new Date().toISOString();
      Object.assign(r, nr);
      await putRequests(env, list);
      return json({ comment, request: normRequest(r) }, 201);
    }
    const reqStatusMatch = path.match(/^\/api\/requests\/([^/]+)\/status$/);
    if (reqStatusMatch && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.SYNC_SECRET) {
        return new Response('unauthorized', { status: 401 });
      }
      let body = {};
      try { body = await request.json(); } catch { /* ignore */ }
      const status = ['open', 'in_progress', 'done', 'needs_info'].includes(body.status) ? body.status : '';
      if (!status) return json({ error: 'status must be open|in_progress|done|needs_info' }, 400);
      const id = decodeURIComponent(reqStatusMatch[1]);
      const list = await getRequests(env);
      const r = list.find((x) => x.id === id);
      if (!r) return json({ error: 'not found' }, 404);
      r.status = status;
      r.updated = new Date().toISOString();
      await putRequests(env, list);
      return json(normRequest(r));
    }
    const reqDelMatch = path.match(/^\/api\/requests\/([^/]+)$/);
    if (reqDelMatch && request.method === 'DELETE') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.SYNC_SECRET) {
        return new Response('unauthorized', { status: 401 });
      }
      const id = decodeURIComponent(reqDelMatch[1]);
      const list = await getRequests(env);
      const kept = list.filter((x) => x.id !== id);
      if (kept.length === list.length) return json({ error: 'not found' }, 404);
      await putRequests(env, kept);
      return json({ ok: true });
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
        const same = findTask(sameDoc, t.child, t.title, t.given_iso);
        const prev = findTask(prevDoc, t.child, t.title, t.given_iso);
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
