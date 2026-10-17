# Study reminders and Preferences

Preferences contains account identity, real session statistics and a score graph, a Theme entry, and Study reminders. Theme choices live on their own page and save immediately on the device. Preparing-for controls, About/FAQ/support placeholders, fake notification switches and sign-out controls are absent from this page.

## Student flow

Reminders are off by default. Enabling them requests browser permission from the student's click, connects that device, then saves the enabled account setting. Denied permission or a failed save never reports success. A connected student can send a test reminder to their own device; the endpoint is authenticated and limited to three attempts per minute.

Smart timing uses the median local start time of up to twenty recent sessions once three suitable sessions exist. Before that, it starts at 19:00. Students can choose a fixed time, selected weekdays, quiet hours, their device time zone, private reminder wording, or a seven-day pause. Default quiet hours are 21:00–08:00. Scheduled times inside quiet hours are rejected rather than silently ignored.

The planner uses saved activity to skip a day already studied, choose a subject worth revisiting, and recognize an actual consecutive-day rhythm. Ungraded practice still counts as studying without being treated as a failed subject. Queued account-scoped summaries retry after reconnect/sign-in; they contain IDs, dates, subject labels, durations and outcomes, never question wording or answer content. Profile choices do not automatically filter Browse. Only an explicit reminder click opens Browse with its relevant subject search. A notification cannot interrupt a timed exam or bypass onboarding.

## Delivery

The backend checks eligible accounts once a minute while it is running. A reminder is eligible during a ninety-minute window around the selected local time, on a selected day, outside quiet hours, when enabled and not paused. It does not replay a missed day's reminder after a long outage. Web Push encrypts each payload using the connected device's keys. Expired endpoints are removed; temporary failures have a fifteen-minute backoff and at most three attempts for that day.

SQLite claims prevent overlapping schedulers from processing the same daily intent concurrently. A per-day notification tag, `renotify: false`, and the provider topic suppress duplicate visible nudges. A crash after provider acceptance but before acknowledgement can cause a replacement delivery; exact device delivery is not claimed. A successful test response means the push provider accepted the request, not that an OS banner was displayed.

The push-only service worker never caches authentication or API responses. Notification navigation is restricted to the app's origin. Existing windows receive a message rather than a forced reload, preserving a running exam. The browser/OS controls notification styling, delivery timing and Focus modes; this implementation is Web Push, not an iOS Live Activity or native Android service.

Scholar now supplies a first-party portrait icon and a larger expression image for both tests and scheduled reminders. Real activity chooses welcome, gentle encouragement or celebration; private wording always uses the neutral welcome expression. The worker accepts only these known local assets and ignores arbitrary payload image URLs. The test action refreshes an existing worker before sending so an old installation cannot discard the artwork. Browser/OS support determines whether the larger image or custom icon appears; see [notification image options](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification). Asset prompts and final paths are recorded in [Scholar reminder artwork](scholar-reminder-art.md).

## Runtime and storage

- Run the matching backend release on Node.js 22.13+ in an always-on process. Sleeping hosts delay scheduled checks.
- Configure the existing Supabase authentication settings, a stable `SESSION_OWNER_HMAC_SECRET`, persistent writable `DATA_DIR`, and the actual HTTPS frontend origin in `FRONTEND_URL`.
- `WEB_PUSH_SUBJECT` optionally supplies an HTTPS contact URL or `mailto:` address. Otherwise the first HTTPS frontend origin is used. If neither is available, the UI reports reminders unavailable and does not enable delivery.
- VAPID keys generate once into `DATA_DIR/study-reminders.db`. Optional `WEB_PUSH_PUBLIC_KEY` and `WEB_PUSH_PRIVATE_KEY` must be set as a pair and kept stable. Never put the private key in frontend variables.
- The same private SQLite database stores HMAC-scoped settings, up to ten device subscriptions per account, the latest 120 study summaries, and delivery state. On Unix it is created with mode 0600. No Supabase schema migration is needed.
- Keep this database and its keys on the existing persistent volume. The existing `deploy/backup.sh` snapshots every SQLite database, including this one. Preserve the ownership secret and VAPID keys during updates and restores. Changing keys requires devices to reconnect.
- Browser account changes unsubscribe the previous local device; the server only permits the authenticated owner to manage settings or send a test. Student tokens are never stored for background delivery.

## Release checks

1. Deploy the backend before the frontend. Confirm the unauthenticated `/api/reminders` route returns 401 with authentication configured; an older API returns 404.
2. Serve the frontend over HTTPS with the correct `VITE_API_URL`. Keep the web manifest, app icons and `/study-reminders-sw.js` accessible at their root paths. The worker must revalidate rather than use an immutable cache policy.
3. Sign in as a real test student, enable reminders from Preferences, grant permission, and use **Send test reminder**. Verify foreground/background delivery and notification navigation on actual devices. Do not bulk-test student accounts.
4. On iPhone/iPad, add PastQ to the Home Screen, reopen it there, then enable notifications. Safari 16.4+ web push requires the installed Home Screen app and an explicit user gesture.
5. Exercise fixed/smart timing, quiet hours, selected days, pause/resume, disabling with unsaved form edits, account switching and a backend restart. Check that completed practice suppresses the next planned reminder after its summary has reached the server.

Automated checks cover scheduling/time zones (including DST), validation, persistence, duplicate claims, bounded retries, account/device isolation, declined permissions, offline-summary retry, real Web Push encryption, worker navigation and visible fallbacks. Browser flow checks intercept account/reminder endpoints and mock push registration; they send no real student notifications. They do not certify physical iOS/Android or live hosting configuration.

References: [WebKit Home Screen Web Push](https://webkit.org/blog/13878/), [permission UX](https://web.dev/articles/push-notifications-permissions-ux), [web-push implementation](https://github.com/web-push-libs/web-push), [Duolingo's personalized reminder work](https://blog.duolingo.com/hi-its-duo-the-ai-behind-the-meme/).
