# Discover, offline Home and Library

The former Progress tab is now Discover, with a compass icon. Personal outcomes remain in Preferences, and **View sessions** opens a separate history screen. New students see a Scholar welcome and a first-paper action instead of empty statistic cards or a sample graph.

## Home and device outcomes

Home recommendations use only saved bundles with actual question data on the device. Server-only metadata is excluded. The latest result for each saved paper determines whether it is worth revisiting; otherwise Home offers an untried paper or the least recently practised saved paper. It never needs an online recommendation call to build this plan.

Outcome summaries persist in an account-scoped IndexedDB store (`PastQStudent/practice_history`), capped at 200 records. Summaries contain result IDs, material references, scores, counts, dates and durations, with no question text or answers. They load before network profile/history calls. Online history merges by result ID without erasing local results; old `created_at` rows remain supported. Ungraded questions do not create a false zero score on the device.

Completed outcomes save locally immediately and queue a Supabase history upsert using the existing `exam_sessions.created_at` field. Reconnect, sign-in and visibility changes retry pending records. Concurrent reconnect events share one sync operation, retries reuse the same result ID, and every upload checks the signed-in owner. This uses the existing student-data schema and own-row RLS policies, not a new schema migration. The existing per-question analytics save is separate and still requires its network tables.

These changes provide offline study and personalization inside the loaded app with saved materials. They do not add offline installation or cold-start caching of the app shell.

## Discover

Each listing contains the session name, logo (graduation-cap fallback), type and optional subject/exam tag. Public sessions can be joined directly; private sessions require the tutor's code. Joined sessions remain available to that account. Empty discovery is an honest empty state: no seeded or invented tutors, sessions or attendance numbers.

The authenticated API is `/api/discover`:

- `GET /`: public sessions and the signed-in account's joined sessions. Optional `search` filters public titles/tags. Private sessions never appear in public results.
- `POST /:id/join`: join an open public session, idempotently.
- `POST /join` with `{ "code": "…" }`: join a private session. Codes are 16 hex characters, case-insensitive, accepting spaces/hyphens. The server stores only the hash and limits code attempts.
- `POST /` publishes a session; `POST /:id/end` closes an owned session. These authoring endpoints require a trusted server-verified admin role. Student tokens cannot publish or close sessions. Private invite codes are returned only at creation.

Definitions and account-scoped memberships persist in `DATA_DIR/study-sessions.db` on the existing VPS volume; the backup job already snapshots it. No Supabase tokens are stored in this database. The future teacher application can build on this contract with a reviewed teacher authorization policy. This release does not implement the teacher app, live teaching, hosted exam questions, or a host start/broadcast system. Joined students see a waiting state, not a fabricated live class.

## Library and validation

The earlier illustrated category grid and vertical organization lists are restored without the old descriptive subparagraphs. Small screens stack categories vertically. Search has one visible focus boundary on its container; the inner input has no second outline or shadow.

Automated checks cover offline ranking, account-isolated persistence, legacy dates, reconnect coalescing, private-session discovery boundaries, membership persistence and publishing authorization. Browser checks cover public/private joins, error retry, logo failure, newcomer states, real offline exam completion, reconnect sync and reload at 320, 390, 768 and 1280 px. Tutorial/exam examples in browser tests are intercepted fixtures and are not published on production.
