// Whitworth MVB: static site (public/) + JSON API on D1 + photos on R2.
// Admin routes sit behind Cloudflare Access; the Access JWT is re-verified here.

const json = (data, status = 200) => Response.json(data, { status });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Editable tables. Field types: 'x!' = required. str | date | time | int (>=0 or null) | sort (int, default 0) | email | [enum].
const T = {
  games: { photos: 'many', f: { date: 'date!', time: 'time', opponent: 'str!', location: 'str', home_away: ['home', 'away', 'neutral'], our_score: 'int', their_score: 'int', notes: 'str' }, order: 'date DESC, time DESC' },
  roster: { photos: 'one', f: { name: 'str!', number: 'str', position: 'str', year: 'str', sort: 'sort' }, order: 'sort, name' },
  announcements: { photos: 'many', f: { date: 'date!', title: 'str!', body: 'str' }, order: 'date DESC, id DESC' },
  officers: { pk: 'email', admin: true, photos: 'one', f: { email: 'email!', name: 'str!', title: 'str', role: ['admin', 'editor'] }, order: 'role, name' },
};

export function clean(f, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'Body must be a JSON object');
  const out = {};
  for (const [k, spec] of Object.entries(f)) {
    const t = Array.isArray(spec) ? 'enum' : spec.replace('!', '');
    let v = typeof b[k] === 'string' ? b[k].trim() : b[k];
    if (v == null || v === '') {
      if (spec.endsWith?.('!') || t === 'enum') fail(400, `${k} is required`);
      out[k] = t === 'time' || t === 'int' ? null : t === 'sort' ? 0 : '';
      continue;
    }
    if (t === 'int' || t === 'sort') {
      if (typeof v === 'string' && /^-?\d+$/.test(v)) v = Number(v);
      if (!Number.isInteger(v) || (t === 'int' && v < 0)) fail(400, `${k} must be ${t === 'int' ? 'a whole number >= 0' : 'a whole number'}`);
    } else if (typeof v !== 'string' || v.length > 5000) fail(400, `${k} must be text (max 5000 chars)`);
    else if (t === 'enum' && !spec.includes(v)) fail(400, `${k} must be one of: ${spec.join(', ')}`);
    else if (t === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v))) fail(400, `${k} must be a date (YYYY-MM-DD)`);
    else if (t === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail(400, `${k} must be a time (HH:MM)`);
    else if (t === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v = v.toLowerCase())) fail(400, `${k} must be an email`);
    out[k] = v;
  }
  return out;
}

// ---- Auth ----

const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// Returns the JWT payload if valid (RS256 sig by one of `keys`, aud, iss, exp/nbf), else null.
export async function verifyJwt(token, keys, aud, iss, now = Date.now() / 1000) {
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64(h)));
    const jwk = header.alg === 'RS256' && keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(s), new TextEncoder().encode(`${h}.${p}`)))) return null;
    const c = JSON.parse(new TextDecoder().decode(b64(p)));
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud || !auds.includes(aud) || c.iss !== iss || !(c.exp > now) || (c.nbf && c.nbf > now + 60)) return null;
    return c;
  } catch {
    return null;
  }
}

let jwks = { at: 0, keys: [] }; // ponytail: per-isolate 1h cache; Access overlaps old+new keys on rotation
async function accessKeys(iss) {
  if (Date.now() - jwks.at > 3600e3) {
    const r = await fetch(`${iss}/cdn-cgi/access/certs`);
    if (!r.ok) fail(503, 'Could not fetch Access certs');
    jwks = { at: Date.now(), keys: (await r.json()).keys };
  }
  return jwks.keys;
}

// DEV_EMAIL (from .dev.vars) is honoured only for requests addressed to localhost.
export const devEmail = (url, env) => env.DEV_EMAIL && ['localhost', '127.0.0.1'].includes(new URL(url).hostname) ? env.DEV_EMAIL : null;

async function officer(req, env) {
  let email = devEmail(req.url, env);
  if (!email) {
    const tok = req.headers.get('Cf-Access-Jwt-Assertion');
    const iss = `https://${env.TEAM_DOMAIN}`;
    email = tok && (await verifyJwt(tok, await accessKeys(iss), env.ACCESS_AUD, iss))?.email;
  }
  if (!email) fail(401, 'Not signed in');
  email = email.toLowerCase();
  const me = await env.DB.prepare('SELECT email, name, title, role FROM officers WHERE email = ?').bind(email).first();
  if (!me) fail(403, 'Not an officer');
  return me;
}

// ---- Handlers ----

async function publicData(env) {
  const q = (sql) => env.DB.prepare(sql);
  // First photo of a one-photo entry, as a URL (officer emails never leave the DB).
  const first = (t, ref) => `(SELECT '/photos/' || key FROM photos WHERE kind = '${t}' AND ref = ${ref} ORDER BY sort, id LIMIT 1) AS photo`;
  const [up, res, roster, ann, off, ph] = (await env.DB.batch([
    q('SELECT * FROM games WHERE our_score IS NULL ORDER BY date, time'),
    q('SELECT * FROM games WHERE our_score IS NOT NULL ORDER BY date DESC, time DESC'),
    q(`SELECT *, ${first('roster', 'CAST(roster.id AS TEXT)')} FROM roster ORDER BY ${T.roster.order}`),
    q(`SELECT * FROM announcements ORDER BY ${T.announcements.order} LIMIT 10`),
    q(`SELECT name, title, ${first('officers', 'officers.email')} FROM officers WHERE title != '' ORDER BY role, name`),
    q("SELECT kind, ref, key FROM photos WHERE kind IN ('games', 'announcements') ORDER BY sort, id"),
  ])).map((r) => r.results);
  const attach = (kind, rows) => { for (const r of rows) r.photos = ph.filter((p) => p.kind === kind && p.ref === String(r.id)).map((p) => `/photos/${p.key}`); };
  attach('games', up); attach('games', res); attach('announcements', ann);
  return { upcoming: up, results: res, roster, announcements: ann, officers: off };
}

async function photo(env, key) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: obj.httpEtag });
  obj.writeHttpMetadata(h);
  return new Response(obj.body, { headers: h });
}

const MAX = 5 * 1024 * 1024;
async function upload(req, env, t, id) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) fail(415, 'Only JPEG, PNG or WebP images');
  if (Number(req.headers.get('content-length')) > MAX) fail(413, 'Image over 5 MB');
  const pk = T[t].pk || 'id', ref = String(id);
  if (!(await env.DB.prepare(`SELECT 1 FROM ${t} WHERE ${pk} = ?`).bind(id).first())) fail(404, 'Not found');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) fail(400, 'Empty image');
  if (buf.byteLength > MAX) fail(413, 'Image over 5 MB');
  const key = `${t}/${crypto.randomUUID()}.jpg`; // random name only: never put an officer email in a public URL
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
  let row;
  try {
    row = await env.DB.prepare('INSERT INTO photos (kind, ref, key, sort) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort), -1) + 1 FROM photos WHERE kind = ?1 AND ref = ?2)) RETURNING *').bind(t, ref, key).first();
  } catch (e) {
    await env.PHOTOS.delete(key);
    throw e;
  }
  if (T[t].photos === 'one') await dropPhotos(env, t, ref, row.id); // new headshot replaces the old one
  return json(row, 201);
}

// Delete an entry's photos (R2 objects + rows), optionally keeping one.
async function dropPhotos(env, t, ref, keep = 0) {
  const old = (await env.DB.prepare('SELECT key FROM photos WHERE kind = ? AND ref = ? AND id != ?').bind(t, ref, keep).all()).results.map((r) => r.key);
  if (!old.length) return;
  await env.PHOTOS.delete(old);
  await env.DB.prepare('DELETE FROM photos WHERE kind = ? AND ref = ? AND id != ?').bind(t, ref, keep).run();
}

async function body(req) {
  if (!(req.headers.get('content-type') || '').startsWith('application/json')) fail(415, 'Send JSON'); // also forces a CORS preflight cross-site
  try { return await req.json(); } catch { fail(400, 'Invalid JSON'); }
}

async function photoOp(req, env, me, id, sub) {
  const p = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'Photo not found');
  if (T[p.kind].admin && me.role !== 'admin') fail(403, 'Admins only');
  if (req.method === 'DELETE' && !sub) {
    await env.PHOTOS.delete(p.key);
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (req.method === 'POST' && sub === 'move') {
    const { dir } = await body(req);
    if (dir !== -1 && dir !== 1) fail(400, 'dir must be -1 or 1');
    const all = (await env.DB.prepare('SELECT id FROM photos WHERE kind = ? AND ref = ? ORDER BY sort, id').bind(p.kind, p.ref).all()).results.map((r) => r.id);
    const i = all.indexOf(p.id), j = i + dir;
    if (j >= 0 && j < all.length) [all[i], all[j]] = [all[j], all[i]];
    await env.DB.batch(all.map((pid, n) => env.DB.prepare('UPDATE photos SET sort = ? WHERE id = ?').bind(n, pid)));
    return json({ ok: true });
  }
  fail(405, 'Method not allowed');
}

async function crud(req, env, t, id) {
  const s = T[t], pk = s.pk || 'id', db = env.DB, m = req.method;
  if (m === 'GET' && !id) {
    const rows = (await db.prepare(`SELECT * FROM ${t} ORDER BY ${s.order}`).all()).results;
    const ph = (await db.prepare('SELECT * FROM photos WHERE kind = ? ORDER BY sort, id').bind(t).all()).results;
    for (const r of rows) r.photos = ph.filter((p) => p.ref === String(r[pk])).map((p) => ({ ...p, url: `/photos/${p.key}` }));
    return json(rows);
  }
  if (m === 'POST' && !id) {
    const v = clean(s.f, await body(req));
    check(t, v);
    const cols = Object.keys(v);
    return json(await db.prepare(`INSERT INTO ${t} (${cols}) VALUES (${cols.map(() => '?')}) RETURNING *`).bind(...Object.values(v)).first(), 201);
  }
  if (!id) fail(405, 'Method not allowed');
  if (m === 'PUT') {
    const f = { ...s.f };
    delete f[pk]; // primary key is not editable
    const v = clean(f, await body(req));
    check(t, v);
    const sets = Object.keys(v).map((c) => `${c} = ?`);
    // Officers: refuse to demote the last admin (checked atomically in the WHERE).
    const guard = t === 'officers' ? ` AND (? = 'admin' OR role != 'admin' OR (SELECT COUNT(*) FROM officers WHERE role = 'admin') > 1)` : '';
    const args = [...Object.values(v), id, ...(guard ? [v.role] : [])];
    const row = await db.prepare(`UPDATE ${t} SET ${sets} WHERE ${pk} = ?${guard} RETURNING *`).bind(...args).first();
    if (row) return json(row);
  } else if (m === 'DELETE') {
    // Delete the entry first (the last-admin guard may refuse), then its photos.
    const guard = t === 'officers' ? ` AND (role != 'admin' OR (SELECT COUNT(*) FROM officers WHERE role = 'admin') > 1)` : '';
    if ((await db.prepare(`DELETE FROM ${t} WHERE ${pk} = ?${guard}`).bind(id).run()).meta.changes) {
      await dropPhotos(env, t, String(id));
      return json({ ok: true });
    }
  } else fail(405, 'Method not allowed');
  if (t === 'officers' && (await db.prepare('SELECT 1 FROM officers WHERE email = ?').bind(id).first())) fail(409, 'There must always be at least one admin');
  fail(404, 'Not found');
}

function check(t, v) {
  if (t === 'games' && (v.our_score === null) !== (v.their_score === null)) fail(400, 'Enter both scores or neither');
}

async function route(req, env) {
  const url = new URL(req.url), p = url.pathname;
  if (p === '/api/public' && req.method === 'GET') return json(await publicData(env));
  if (p.startsWith('/photos/') && req.method === 'GET') return photo(env, decodeURIComponent(p.slice(8)));
  if (!p.startsWith('/api/admin/')) return new Response('Not found', { status: 404 });

  const me = await officer(req, env);
  const [t, rawId, sub, extra] = p.slice(11).split('/');
  let id = rawId && decodeURIComponent(rawId);
  if (extra !== undefined) fail(404, 'Not found');
  if (id && t !== 'officers') { if (!/^\d+$/.test(id)) fail(404, 'Not found'); id = Number(id); }
  if (id && t === 'officers') id = id.toLowerCase();
  if (t === 'me' && !id) return json(me);
  if (t === 'photos' && id) return photoOp(req, env, me, id, sub);
  if (!T[t] || (sub !== undefined && !(sub === 'photos' && id && req.method === 'POST'))) fail(404, 'Not found');
  if (T[t].admin && me.role !== 'admin') fail(403, 'Admins only');
  return sub ? upload(req, env, t, id) : crud(req, env, t, id);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      if (e.status) return json({ error: e.message }, e.status);
      if (/UNIQUE/.test(e.message)) return json({ error: 'That already exists' }, 409);
      console.error(e);
      return json({ error: 'Server error' }, 500);
    }
  },
};
