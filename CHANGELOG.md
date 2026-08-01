# Changelog

## 0.1.1

Fixes a scoping bug that could leak unrelated work into the generated file.

Eligibility used to be decided by searching the whole session, title and body together. Work
sessions mention other projects constantly, so a single passing reference was enough to pull an
entire unrelated session in. A real run on a client repository pulled in a salary negotiation, a
third party's code audit, and account recovery details, all because one line listed the project
name among several others.

Eligibility now reads the session title only, which is what Pieces names after the work you
actually did. Matching folds away accents, spacing and separators, so `marco-agenda` still finds
a session titled "Marcô Agenda".

If you ran 0.1.0, re-read any `AGENTS.md` it produced before pushing it anywhere.

## 0.1.0

First release.
