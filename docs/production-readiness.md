# Student onboarding and exam flow

Account creation uses name, email and password (or Google). After authentication,
students choose **Undergraduate** or **Other learner**. Undergraduates choose a
university. Other learners choose a school, an exam, or Explore. Preferences live
in authenticated Supabase account metadata; they are personalization, never an
authorization role. Accounts with a saved study choice skip completed onboarding. Legacy profile completion flags do not bypass the new study choice. The home screen can reopen personalization even after Explore.

Uploads finish extraction, receive a single review, then **Looks good — save**
confirms the complete material before opening session setup. The confirmation is
an authenticated, owner-checked PUT. It validates editable fields and preserves
source figures and provenance. Retrying the PUT updates the same material ID.
Saved uploads always open session setup. Completing corrections returns to Browse.

## Persistence and ownership

- Supabase retains accounts, profiles and student results under existing RLS.
- Question content stays on the VPS. Reviewed uploads are stored in
  `DATA_DIR/reviewed-materials.db` (SQLite WAL), indexed by ownership HMAC and
  update time. This is separate from automatically published source extractions
  in the shared catalog; a student's corrections do not edit that catalog.
- SQLite initializes its additive table/index with `IF NOT EXISTS`. Existing
  extractions and shared bundles are unchanged. No Supabase migration is needed.
- Lists return paginated summaries, not every question. Opening a material checks
  ownership again. Unknown and other-account saved IDs both return 404.
- Offline copies use account-scoped keys. Signing out or switching accounts clears
  in-memory question state; another account cannot list the private cache.
- The existing backup script uses SQLite's online backup API for every `.db` file,
  so it includes the reviewed-material database. Keep that database on the mounted
  data volume. Deleting an extraction through its owned API also removes its saved copy.
- Library JSON writes now use temporary files and atomic rename. Resource IDs are
  validated before constructing session and bundle paths.

## Checks and protections added

Login/signup have a per-IP request limit with retry guidance, bounded rate-limit
storage, small request bodies, and server-side credential validation. Plus-addressed
emails and international names are preserved. New passwords require 8–128
characters; existing shorter passwords can still sign in. Each server auth request
uses an independent Supabase client. Recovery links open a password-update screen;
Supabase owns token expiry/single-use validation. Auth responses are not cached.

Production wildcard CORS is disabled. API and frontend responses set basic browser
security headers. A patched `proxy-addr` is locked in the server dependency tree.
GitHub Actions runs frontend tests/build, backend tests, and production-dependency
audits on pushes and pull requests. Require those checks in branch protection;
adding a workflow alone does not block a deployment integration.

Tests cover reviewed edits, invalid payloads, idempotent retries, database restart
persistence, authenticated API access across two accounts, account-scoped offline
storage, onboarding branches and recovery errors. Browser checks exercise account
creation and upload → review → failed-save retry → setup → exam → corrections →
Browse → saved setup. Phone checks use responsive Chromium viewports, including
375px/390px; they do not certify native Android/iOS or Safari behavior. Scholar
uses still poses on permanent screens, a subtle loading breath and a single smiling result pose. It respects reduced motion, and exam timing already follows wall-clock deadlines
when a phone suspends the tab.

## Live release checks

These require access to the actual hosting/provider configuration and are not
proven by local tests:

1. Verify Supabase RLS is deployed, email confirmation is enabled, reset links
   expire and cannot be reused, and Google redirect allowlists match production.
2. Test a backup restore on a separate volume, including both SQLite databases,
   session JSON and figures. Keep an encrypted off-host backup; local nightly files
   alone do not cover losing the VPS. Roll back application code without dropping
   `reviewed_materials` or deleting saved student data.
3. Deploy backend and frontend together. Check readiness, real signup/reset,
   real uploads, persistence after a server restart, and browser Back on devices.
4. Verify production origins, HTTPS, upload limits, monitoring/alerts, provider
   spend limits and log retention. The current limiter is single-process; shared
   rate-limit storage is needed before adding API instances.
5. Exercise iOS Safari and Android Chrome on real phones: keyboard, camera,
   safe-area insets, scrolling, background timers and slow/offline connections.
6. File type/signature and size validation exist; an antivirus/quarantine service,
   per-student model budget and a security penetration test are not added here.

Enterprise SSO/SCIM, payments, healthcare compliance and audit certifications are
not required by this student practice flow and are not claimed by these changes.
