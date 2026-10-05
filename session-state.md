# Whitworth MVB — session state

_Updated automatically at end of session. Newest on top._

## 2026-10-04 — Officer CMS live: photos on every entry type

**State:** Deployed and working at https://whitworthmensvolleyball.com (whitworthmvb.com 301s to it). Repo clean, pushed, `HEAD` = `c24c999`.

**What's live:**
- Two domains bought on Cloudflare (whitworthmensvolleyball.com, whitworthmvb.com), redirect wired, HTTPS enforced on both.
- Cloudflare Email Routing: `team@` on both domains forwards to henrybonikowsky@gmail.com. Outgoing "send as" from Gmail is NOT set up (would need an SMTP relay) — only mentioned, not requested.
- Site moved off GitHub Pages onto a Cloudflare Worker (`public/` assets + `src/worker.js` API) with D1 (`mvb-db`) + R2 (`mvb-photos`).
- Officer login via Cloudflare Access (one-time-email-code) in front of `/admin` and `/api/admin/*`, re-verified server-side (RS256 JWT check, not just trusting Access).
- Roles: `admin` (henrybonikowsky@gmail.com is the sole seed admin, currently hidden from the public Officers list — no title set) and `editor`. Last admin can't be deleted/demoted (409).
- CRUD for games (schedule = no score, results = scored), roster, announcements, officers — all through `/admin`.
- Photos on every entry type: games/announcements get multi-photo slideshows, roster/officers get one headshot each (new upload replaces old). Client-side resize to 1600px/JPEG before upload. R2 keys are random UUIDs, never officer emails, even for officer headshots.
- Logo: 3 original concepts drawn in Figma (no Whitworth marks) at https://www.figma.com/design/LfXCrUi398sRCA6806JzkX — site uses concept C (WHITWORTH wordmark, volleyball as the I-dot, net under the wordmark). Favicon is the volleyball (`assets/ball.svg`).
- Tests: `test/jwt.check.mjs` + `test/smoke.sh` — 79/79 passing as of last run. Live smoke-tested the deployed admin flow (create game → upload photo → confirm on public site → delete → confirm photo gone from R2) directly against production.

**Open / not done:**
- No real officers added yet beyond Henry (admin). No real schedule/roster/announcements content — site is empty of real data.
- Gmail "Send as" for team@ addresses not set up (reply would show your personal Gmail unless added).
- Design is intentionally plain/minimal per user request ("minimal but actually accurate" on the logo net/ball).
- `CLAUDE.md` in this repo has full architecture + redeploy steps if a fresh session needs to pick this up.
