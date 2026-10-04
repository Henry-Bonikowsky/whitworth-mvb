# Whitworth MVB site

Cloudflare Worker + static assets. Officers edit content at `/admin`; no build step, no deps.

## Layout
- `public/` - static site served as Worker assets. `index.html` renders from `GET /api/public`; `admin.html` is the officer CMS.
- `src/worker.js` - API. Routes:
  - `GET /api/public` - upcoming games (no score), results (scored, with photo URLs), roster, announcements (10), officers (name+title only).
  - `GET /photos/<key>` - streams from R2, 1-year immutable cache.
  - `/api/admin/*` - `me`; CRUD `games|roster|announcements|officers` (`GET`/`POST` on the collection, `PUT`/`DELETE` on `/:id`, officers keyed by email);
    `POST games/:id/photos` (raw image body, jpeg/png/webp, max 5 MB); `DELETE photos/:id`; `POST photos/:id/move {dir:-1|1}`.
- `schema.sql` - D1 tables + seed admin (idempotent).
- Bindings: D1 `DB` (`mvb-db`), R2 `PHOTOS` (`mvb-photos`), vars `TEAM_DOMAIN`, `ACCESS_AUD`.

## Auth
Cloudflare Access protects `/admin*` and `/api/admin*`. The Worker still verifies `Cf-Access-Jwt-Assertion` (RS256 vs
`https://TEAM_DOMAIN/cdn-cgi/access/certs`, aud, iss, exp), then looks the email up in `officers`.
Roles: editor = games/roster/announcements/photos; admin = also officers. At least one admin always (409 otherwise).
Local dev: `.dev.vars` `DEV_EMAIL=...` is used as identity, only when the request host is localhost/127.0.0.1.

## Local dev + tests
```
npx -y wrangler@latest d1 execute mvb-db --local --file=schema.sql
echo DEV_EMAIL=henrybonikowsky@gmail.com > .dev.vars
npx -y wrangler@latest dev            # http://localhost:8787, /admin
node test/jwt.check.mjs               # JWT verify, DEV_EMAIL host gate, input validation
bash test/smoke.sh                    # needs wrangler dev running; exercises every API route, cleans up after itself
```

## Deploy (first time)
1. `npx wrangler login`
2. `npx wrangler d1 create mvb-db` -> paste `database_id` into `wrangler.jsonc`.
3. `npx wrangler r2 bucket create mvb-photos`
4. `npx wrangler d1 execute mvb-db --remote --file=schema.sql`
5. Zero Trust -> Access -> Applications -> Self-hosted: domains `whitworthmensvolleyball.com` and `www.whitworthmensvolleyball.com`,
   paths `admin*` and `api/admin*`. Policy: Allow, e.g. emails of officers (or anyone with one-time PIN - the Worker's officer table is the real gate).
   Copy the app's **Application Audience (AUD) tag** -> `ACCESS_AUD`, and your team domain (`<team>.cloudflareaccess.com`) -> `TEAM_DOMAIN`.
6. Uncomment `routes` in `wrangler.jsonc` (custom domains for apex + www), then `npx wrangler deploy`.
7. GitHub Pages: the site moved to `public/`, so Pages stops serving it once this is pushed. Switch DNS to the Worker, then disable Pages and delete `CNAME`.

Editors/admins are added in `/admin` -> Officers (email must match what they log in to Access with).
