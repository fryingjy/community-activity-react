# Privacy

Community Activity Lite has no analytics, advertising, telemetry, developer
server, remote configuration, or third-party API integration.

The extension detects the member-pagination request used by the visible X
Members page, retrieves roster pages directly from x.com, and uses the existing
x.com login to count Community posts. If cursor pagination is unavailable, it
reads visible usernames from the Members page instead. The `ct0` cookie is read
only to supply X's CSRF request header. Cookies and tokens are never logged or
exported.

During operation discovery, the extension may observe URLs matching
`https://x.com/i/api/graphql/*` while reloading the visible Members page. This
is used only to identify the current operation ID and its public query
variables. When Chrome exposes request headers, the extension selects only the
`x-client-transaction-id` value needed to replay the same live operation; it
does not select, log, store, or export cookie, authorization, or CSRF headers.
Response bodies are parsed in memory for the requested roster/activity fields
and are never logged or exported in full.

The Community ID, lookback, threshold, focus-lock preference, and successful
cursor roster pages are saved in `chrome.storage.local`. Roster pages include
public account identifiers, usernames, display names, Community roles, and
protected-account status. These checkpoints let an interrupted scan resume.
Post-analysis cursors, author counters, and completed flagged results are also
saved locally so a closed side panel can resume or restore the last scan.
Activity-window completeness is stored separately from the optional historical
author-backfill state so a partial backfill cannot be mistaken for incomplete
activity coverage.

Latest, Media, and Community-search author archives use separate local
checkpoints. Search uses a fixed set of common terms and sends those queries
only to X through the signed-in browser session. These additional responses are
handled under the same no-telemetry and no-response-body-export rules.

The extension also stores a compact confirmed-member archive keyed primarily
by stable X user ID. It retains first and last confirmation timestamps,
snapshot sightings, protected-account state, and discovery categories across
scans. This archive measures accumulated coverage only: historical records are
not silently reintroduced into current removal results. Exact membership
verification keeps a separate local pending queue and removes candidates after
X returns a checked result.

Detected private-account results are stored as soon as roster collection
finishes, and are updated if later Community-author evidence adds records. The
separate export therefore remains available after stopping or reopening the
panel without waiting for post analysis. This storage is restricted to trusted
extension contexts. CSV and text files are created only when the user selects
an export button.

Requests go directly from the browser to `https://x.com`. No scan data is sent
to another service. The extension has no third-party roster-service host
permission and accepts no external API token.

The side panel's Storage section shows how much local data is saved and for
how many Communities, and offers two distinct controls: **Clear this
Community** removes every roster/activity/verification/archive key for one
Community ID, and **Clear all Community Activity data** removes everything
the extension has stored, including saved settings. Both require an explicit
confirmation before running. Neither is the same as **Discard resume** on an
incomplete-scan notice, which only forgets that notice and deliberately
leaves every checkpoint in place so a later scan can still resume from it —
see that button's own on-panel copy for the distinction.

Uninstalling the extension removes its saved settings under normal Chrome
behavior; exported CSV files remain under the user's control.

## Permissions

Audited 2026-08-08 against the manifest as shipped, by grepping the codebase
for every API each permission actually gates — not assumed from what the
extension does conceptually. Every permission below has confirmed, current
call sites; none is requested "in case it's needed later."

- **`cookies`** — reads exactly one cookie, `ct0` on `x.com`, to supply X's
  CSRF header (`src/api/graphqlClient.js`). Never reads, logs, or exports it.
- **`storage`** / **`unlimitedStorage`** — every checkpoint, cache, and saved
  result described above. `unlimitedStorage` exists because a large
  Community's roster and archive checkpoints can exceed Chrome's default
  unextended quota; it does not grant any capability beyond storing more
  local data.
- **`scripting`** — `chrome.scripting.executeScript` injects the DOM
  fallback/reconciliation collector into the visible X Members tab and reads
  the live page's detected GraphQL operation (`domScan.js`, `sidepanel.js`).
  This is how the extension collects a roster when direct cursor pagination
  is unavailable, and how it discovers X's current persisted-query document
  IDs without hardcoding them (see `ENDPOINT_AUDIT.md` on why those rotate).
- **`webRequest`** — a single, read-only, non-blocking
  `chrome.webRequest.onBeforeSendHeaders` listener, scoped to
  `https://x.com/i/api/graphql/*`, used only to read the live
  `x-client-transaction-id` request header the browser's own page is already
  sending (`domScan.js`). Nothing is modified, cancelled, or redirected; no
  broader URL pattern is registered.
- **`sidePanel`** — the extension's entire UI surface.
- **Host permission `https://x.com/*`** — every request this extension makes
  goes directly from the browser to `x.com`; there is no other host
  permission and no third-party API integration.

`tests/extensionArtifacts.test.js` pins that `chrome.scripting` and
`chrome.webRequest` both have real call sites in the source, so a future
permission removal (or an unused permission creeping back in) has to be a
deliberate, reviewed change rather than a silent drift.
