// Whitworth MVB: static site (public/) + JSON API on D1 + photos on R2.
// Admin routes sit behind Cloudflare Access; the Access JWT is re-verified here.

const json = (data, status = 200) => Response.json(data, { status });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Editable tables. Field types: 'x!' = required. str | date | time | int (>=0 or null) | sort (int, default 0) | email | [enum].
const T = {
  games: { f: { date: 'date!', time: 'time', opponent: 'str!', location: 'str', home_away: ['home', 'away', 'neutral'], our_score: 'int', their_score: 'int', notes: 'str' }, order: 'date DESC, time DESC' },
  roster: { f: { name: 'str!', number: 'str', position: 'str', year: 'str', sort: 'sort' }, order: 'sort, name' },
  announcements: { f: { date: 'date!', title: 'str!', body: 'str' }, order: 'date DESC, id DESC' },
  officers: { pk: 'email', admin: true, f: { email: 'email!', name: 'str!', title: 'str', role: ['admin', 'editor'] }, order: 'role, name' },
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
  const [up, res, roster, ann, off, ph] = (await env.DB.batch([
    q('SELECT * FROM games WHERE our_score IS NULL ORDER BY date, time'),
    q('SELECT * FROM games WHERE our_score IS NOT NULL ORDER BY date DESC, time DESC'),
    q(`SELECT * FROM roster ORDER BY ${T.roster.order}`),
    q(`SELECT * FROM announcements ORDER BY ${T.announcements.order} LIMIT 10`),
    q('SELECT name, title FROM officers ORDER BY role, name'),
    q('SELECT game_id, key FROM photos ORDER BY sort, id'),
  ])).map((r) => r.results);
  for (const g of res) g.photos = ph.filter((p) => p.game_id === g.id).map((p) => `/photos/${p.key}`);
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
async function upload(req, env, gid) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) fail(415, 'Only JPEG, PNG or WebP images');
  if (Number(req.headers.get('content-length')) > MAX) fail(413, 'Image over 5 MB');
  if (!(await env.DB.prepare('SELECT 1 FROM games WHERE id = ?').bind(gid).first())) fail(404, 'Game not found');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) fail(400, 'Empty image');
  if (buf.byteLength > MAX) fail(413, 'Image over 5 MB');
  const key = `games/${gid}/${crypto.randomUUID()}.jpg`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
  try {
    return json(await env.DB.prepare('INSERT INTO photos (game_id, key, sort) VALUES (?1, ?2, (SELECT COALESCE(MAX(sort), -1) + 1 FROM photos WHERE game_id = ?1)) RETURNING *').bind(gid, key).first(), 201);
  } catch (e) {
    await env.PHOTOS.delete(key);
    throw e;
  }
}

async function body(req) {
  if (!(req.headers.get('content-type') || '').startsWith('application/json')) fail(415, 'Send JSON'); // also forces a CORS preflight cross-site
  try { return await req.json(); } catch { fail(400, 'Invalid JSON'); }
}

async function photoOp(req, env, id, sub) {
  const p = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'Photo not found');
  if (req.method === 'DELETE' && !sub) {
    await env.PHOTOS.delete(p.key);
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (req.method === 'POST' && sub === 'move') {
    const { dir } = await body(req);
    if (dir !== -1 && dir !== 1) fail(400, 'dir must be -1 or 1');
    const all = (await env.DB.prepare('SELECT id FROM photos WHERE game_id = ? ORDER BY sort, id').bind(p.game_id).all()).results.map((r) => r.id);
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
    if (t === 'games') {
      const ph = (await db.prepare('SELECT * FROM photos ORDER BY sort, id').all()).results;
      for (const g of rows) g.photos = ph.filter((p) => p.game_id === g.id).map((p) => ({ ...p, url: `/photos/${p.key}` }));
    }
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
    if (t === 'games') {
      const keys = (await db.prepare('SELECT key FROM photos WHERE game_id = ?').bind(id).all()).results.map((r) => r.key);
      if (keys.length) await env.PHOTOS.delete(keys);
      const [, g] = await db.batch([db.prepare('DELETE FROM photos WHERE game_id = ?').bind(id), db.prepare('DELETE FROM games WHERE id = ?').bind(id)]);
      if (g.meta.changes) return json({ ok: true });
    } else {
      const guard = t === 'officers' ? ` AND (role != 'admin' OR (SELECT COUNT(*) FROM officers WHERE role = 'admin') > 1)` : '';
      if ((await db.prepare(`DELETE FROM ${t} WHERE ${pk} = ?${guard}`).bind(id).run()).meta.changes) return json({ ok: true });
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
  if (t === 'photos' && id) return photoOp(req, env, id, sub);
  if (t === 'games' && id && sub === 'photos' && req.method === 'POST') return upload(req, env, id);
  if (!T[t] || sub !== undefined) fail(404, 'Not found');
  if (T[t].admin && me.role !== 'admin') fail(403, 'Admins only');
  return crud(req, env, t, id);
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
