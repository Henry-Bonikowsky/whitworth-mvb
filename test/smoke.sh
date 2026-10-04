#!/usr/bin/env bash
# Smoke test against a running local `npx wrangler dev --local-upstream localhost:8787` (schema applied, .dev.vars DEV_EMAIL=henrybonikowsky@gmail.com,
# henry the only admin). Cleans up everything it creates.  Usage: bash test/smoke.sh
cd "$(dirname "$0")/.."
B=${BASE:-http://localhost:8787}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok=0; bad=0
req() { CODE=$(curl -s -o "$T/b" -w '%{http_code}' -X "$1" "$B$2" "${@:3}"); BODY=$(cat "$T/b"); }
js() { req "$1" "$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
is() { if [ "$CODE" = "$1" ] && [[ "$BODY" == *"$3"* ]]; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL: $2 -> $CODE $BODY"; fi; }
id() { sed -E 's/.*"id":([0-9]+).*/\1/' <<<"$BODY"; }
sql() { npx -y wrangler@latest d1 execute mvb-db --local --command "$1" >/dev/null 2>&1; }
ME=henrybonikowsky@gmail.com

req GET /api/public;                         is 200 "public api" '"officers":['
[[ "$BODY" != *"@"* ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: public api leaks an email"; }
req GET /api/admin/me;                       is 200 "me" '"role":"admin"'

# Games + validation
js POST /api/admin/games '{"date":"2026-10-20","time":"19:00","opponent":"Gonzaga <script>","location":"Fieldhouse","home_away":"home"}'; is 201 "add upcoming game" '"our_score":null'; G1=$(id)
js POST /api/admin/games '{"date":"2026-09-20","opponent":"EWU","home_away":"away","our_score":3,"their_score":1}'; is 201 "add result game"; G2=$(id)
js PUT /api/admin/games/$G1 '{"date":"2026-10-21","opponent":"Gonzaga","home_away":"neutral","notes":"x"}'; is 200 "edit game" '"home_away":"neutral"'
js POST /api/admin/games '{"date":"2026-02-30","opponent":"X","home_away":"home"}'; is 400 "bad date" 'date'
js POST /api/admin/games '{"date":"2026-10-01","opponent":"X","home_away":"road"}'; is 400 "bad enum" 'home_away'
js POST /api/admin/games '{"date":"2026-10-01","opponent":"X","home_away":"home","our_score":-1,"their_score":0}'; is 400 "negative score" 'our_score'
js POST /api/admin/games '{"date":"2026-10-01","opponent":"X","home_away":"home","our_score":2}'; is 400 "one score only" 'both scores'
js POST /api/admin/games '{"date":"2026-10-01","home_away":"home"}'; is 400 "missing opponent" 'opponent is required'
js POST /api/admin/games '{"date":"2026-10-01","opponent":"X","home_away":"home","time":"7pm"}'; is 400 "bad time" 'time'
js POST /api/admin/games 'not json';         is 400 "invalid json" 'Invalid JSON'
req POST /api/admin/games -H 'content-type: text/plain' -d '{}'; is 415 "non-json content-type" 'JSON'
js PUT /api/admin/games/99999 '{"date":"2026-10-01","opponent":"X","home_away":"home"}'; is 404 "edit missing game"

# Photos
echo '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=' | base64 -d > "$T/a.jpg"
img() { req POST /api/admin/${4:-games}/$1/photos -H "content-type: ${2:-image/jpeg}" --data-binary @"${3:-$T/a.jpg}"; }
img $G2; is 201 "upload photo 1" '"sort":0'; P1=$(id); K1=$(sed -E 's/.*"key":"([^"]+)".*/\1/' <<<"$BODY")
img $G2; is 201 "upload photo 2" '"sort":1'; P2=$(id)
img $G2 image/png; is 201 "upload png" ; P3=$(id)
img $G2 text/plain; is 415 "reject non-image" 'Only'
head -c 6000000 /dev/zero > "$T/big"; img $G2 image/jpeg "$T/big"; is 413 "reject >5MB" '5 MB'
img 99999; is 404 "upload to missing game" 'Not found'
[[ "$K1" =~ ^games/[0-9a-f-]{36}\.jpg$ ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: key format $K1"; }
CODE=$(curl -s -D "$T/h" -o "$T/got" -w '%{http_code}' "$B/photos/$K1")
[ "$CODE" = 200 ] && cmp -s "$T/a.jpg" "$T/got" && grep -qi 'content-type: image/jpeg' "$T/h" && grep -qi 'max-age=31536000' "$T/h" && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: fetch photo $CODE"; }
req GET /photos/games/0/nope.jpg;            is 404 "missing photo"
js POST /api/admin/photos/$P2/move '{"dir":-1}'; is 200 "move photo up"
req GET /api/public; [[ "$BODY" == *"\"photos\":[\"/photos/games/"* ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: public photos"; }
req GET /api/admin/games; [[ $(grep -o "\"id\":$P2,\"kind\":\"games\",\"ref\":\"$G2\",\"key\":\"[^\"]*\",\"sort\":0" <<<"$BODY") ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: reorder"; }
js DELETE /api/admin/photos/$P3;             is 200 "delete photo"
js DELETE /api/admin/photos/$P3;             is 404 "delete photo twice"
js DELETE /api/admin/games/$G2;              is 200 "delete game with photos"
req GET /photos/$K1;                         is 404 "game delete removed R2 object"
js DELETE /api/admin/photos/$P1;             is 404 "game delete removed photo rows"

# Roster + announcements
js POST /api/admin/roster '{"name":"Sam","number":"7","position":"OH","year":"Jr","sort":"2"}'; is 201 "add player" '"sort":2'; R=$(id)
js PUT /api/admin/roster/$R '{"name":"Sam B","sort":1}'; is 200 "edit player" 'Sam B'
js POST /api/admin/roster '{"name":"","sort":1}'; is 400 "player needs name"
js POST /api/admin/announcements '{"date":"2026-10-01","title":"Tryouts","body":"Mon 7pm"}'; is 201 "add announcement"; A=$(id)
req GET /api/public;                         is 200 "public shows content" '"title":"Tryouts"'
# Photos on every entry type
img $R 'image/jpeg' '' roster; is 201 "player headshot" '"kind":"roster"'; KR1=$(sed -E 's/.*"key":"([^"]+)".*/\1/' <<<"$BODY")
img $R 'image/jpeg' '' roster; is 201 "replace headshot" '"sort":1'; KR2=$(sed -E 's/.*"key":"([^"]+)".*/\1/' <<<"$BODY")
req GET /photos/$KR1;                        is 404 "old headshot removed from R2"
req GET /api/admin/roster; [[ $(grep -o '"kind":"roster"' <<<"$BODY" | wc -l) = 1 ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: one headshot per player"; }
req GET /api/public;                         is 200 "public roster photo" "\"photo\":\"/photos/$KR2\""
img $A 'image/jpeg' '' announcements; is 201 "announcement photo 1"
img $A 'image/jpeg' '' announcements; is 201 "announcement photo 2" '"sort":1'
req GET /api/public; [[ "$BODY" == *'"title":"Tryouts"'*'"photos":["/photos/announcements/'*'","/photos/announcements/'* ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: public announcement photos"; }
img 99999 'image/jpeg' '' roster;            is 404 "photo for missing player"
req POST /api/admin/roster/$R/nope -H 'content-type: image/jpeg' --data-binary @"$T/a.jpg"; is 404 "unknown sub-route"
js DELETE /api/admin/roster/$R;              is 200 "delete player"
req GET /photos/$KR2;                        is 404 "player delete removed headshot"
js DELETE /api/admin/announcements/$A;       is 200 "delete announcement"
req GET /api/admin/nope;                     is 404 "unknown table"

# Officers + last-admin invariant
js DELETE /api/admin/officers/$ME;           is 409 "can't delete last admin" 'at least one admin'
js PUT /api/admin/officers/$ME '{"name":"Henry Bonikowsky","role":"editor"}'; is 409 "can't demote last admin" 'at least one admin'
js POST /api/admin/officers '{"email":"Ed@Test.local","name":"Ed","role":"editor"}'; is 201 "add editor (lowercased)" '"email":"ed@test.local"'
js POST /api/admin/officers '{"email":"ed@test.local","name":"Ed","role":"editor"}'; is 409 "duplicate officer"
js POST /api/admin/officers '{"email":"x@y.com","name":"X","role":"boss"}'; is 400 "bad role"
js POST /api/admin/officers '{"email":"nope","name":"X","role":"editor"}'; is 400 "bad email"
js POST /api/admin/officers '{"email":"ad@test.local","name":"Ad","role":"admin"}'; is 201 "add second admin"
js PUT /api/admin/officers/ed@test.local '{"name":"Ed","title":"Secretary","role":"editor"}'; is 200 "give editor a title"
img ed@test.local 'image/jpeg' '' officers;  is 201 "officer headshot" '"ref":"ed@test.local"'; PO=$(id); KO=$(sed -E 's/.*"key":"([^"]+)".*/\1/' <<<"$BODY")
[[ "$KO" =~ ^officers/[0-9a-f-]{36}\.jpg$ ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: officer photo key leaks email: $KO"; }
req GET /api/public;                         is 200 "public officer photo" "\"photo\":\"/photos/$KO\""
[[ "$BODY" != *"@"* ]] && ok=$((ok+1)) || { bad=$((bad+1)); echo "FAIL: public api leaks an email (photos)"; }
js DELETE /api/admin/officers/$ME;           is 200 "admin removable when another admin exists"
sql "INSERT INTO officers VALUES ('$ME','Henry Bonikowsky','','admin')"
js PUT /api/admin/officers/$ME '{"name":"Henry Bonikowsky","title":"President","role":"editor"}'; is 200 "demote self (2 admins)" '"role":"editor"'
# now henry is an editor
req GET /api/admin/me;                       is 200 "me as editor" '"role":"editor"'
req GET /api/admin/officers;                 is 403 "editor can't list officers" 'Admins only'
js DELETE /api/admin/officers/ed@test.local; is 403 "editor can't delete officers"
js POST /api/admin/officers '{"email":"z@z.com","name":"Z","role":"admin"}'; is 403 "editor can't add officers"
img ed@test.local 'image/jpeg' '' officers;  is 403 "editor can't upload officer photo"
js DELETE /api/admin/photos/$PO;             is 403 "editor can't delete officer photo"
js POST /api/admin/games '{"date":"2026-11-01","opponent":"WSU","home_away":"home"}'; is 201 "editor can add game"; G3=$(id)
js DELETE /api/admin/games/$G3;              is 200 "editor can delete game"
sql "DELETE FROM officers WHERE email='$ME'"
req GET /api/admin/me;                       is 403 "non-officer" 'Not an officer'
req GET /api/admin/games;                    is 403 "non-officer blocked from data"
sql "INSERT INTO officers VALUES ('$ME','Henry Bonikowsky','','admin')"
js DELETE /api/admin/officers/ed@test.local; is 200 "admin deletes editor"
req GET /photos/$KO;                         is 404 "officer delete removed headshot"
js DELETE /api/admin/officers/ad@test.local; is 200 "delete other admin"
js DELETE /api/admin/games/$G1;              is 200 "cleanup game"

echo "smoke: $ok passed, $bad failed"
[ $bad = 0 ]
