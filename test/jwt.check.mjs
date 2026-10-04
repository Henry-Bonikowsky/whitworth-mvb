// node test/jwt.check.mjs  - self-check for verifyJwt, clean, devEmail (no deps)
import assert from 'node:assert/strict';
import { verifyJwt, devEmail, clean } from '../src/worker.js';

const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const good = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const evil = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const keys = [{ ...(await crypto.subtle.exportKey('jwk', good.publicKey)), kid: 'k1' }];
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ISS = 'https://team.cloudflareaccess.com', AUD = 'aud123', now = Math.floor(Date.now() / 1000);
async function sign(claims, key = good.privateKey, header = { alg: 'RS256', kid: 'k1' }) {
  const data = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}
const base = { email: 'a@b.com', aud: [AUD], iss: ISS, exp: now + 300, iat: now };
const v = (t) => verifyJwt(t, keys, AUD, ISS);

assert.equal((await v(await sign(base)))?.email, 'a@b.com', 'valid token');
assert.equal((await v(await sign({ ...base, aud: AUD })))?.email, 'a@b.com', 'string aud');
assert.equal(await v(await sign(base, evil.privateKey)), null, 'bad signature');
assert.equal(await v(await sign({ ...base, aud: ['other'] })), null, 'wrong aud');
assert.equal(await v(await sign({ ...base, iss: 'https://evil.cloudflareaccess.com' })), null, 'wrong iss');
assert.equal(await v(await sign({ ...base, exp: now - 1 })), null, 'expired');
assert.equal(await v(await sign(base, good.privateKey, { alg: 'RS256', kid: 'nope' })), null, 'unknown kid');
assert.equal(await v(await sign(base, good.privateKey, { alg: 'none', kid: 'k1' })), null, 'alg none');
const t = await sign(base), [h, , s] = t.split('.');
assert.equal(await v(`${h}.${enc({ ...base, email: 'x@y.com' })}.${s}`), null, 'tampered payload');
assert.equal(await v('garbage'), null, 'garbage');
assert.equal(await verifyJwt(t, keys, undefined, ISS), null, 'missing ACCESS_AUD');

const env = { DEV_EMAIL: 'dev@x.com' };
assert.equal(devEmail('http://localhost:8787/api/admin/me', env), 'dev@x.com');
assert.equal(devEmail('http://127.0.0.1:8787/x', env), 'dev@x.com');
assert.equal(devEmail('https://whitworthmensvolleyball.com/api/admin/me', env), null, 'prod host ignores DEV_EMAIL');
assert.equal(devEmail('http://localhost.evil.com/x', env), null);
assert.equal(devEmail('http://localhost/x', {}), null);

const f = { d: 'date!', n: 'int', e: ['a', 'b'] };
assert.deepEqual(clean(f, { d: '2026-02-28', n: '3', e: 'a' }), { d: '2026-02-28', n: 3, e: 'a' });
assert.deepEqual(clean(f, { d: '2026-02-28', n: '', e: 'b' }), { d: '2026-02-28', n: null, e: 'b' });
for (const bad of [{ d: '2026-02-30', e: 'a' }, { d: '2026-02-28', e: 'c' }, { d: '2026-02-28', n: -1, e: 'a' }, { d: '2026-02-28', n: 1.5, e: 'a' }, { e: 'a' }])
  assert.throws(() => clean(f, bad), (e) => e.status === 400, JSON.stringify(bad));
console.log('jwt.check: all assertions passed');
