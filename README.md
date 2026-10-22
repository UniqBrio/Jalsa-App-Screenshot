# Any-App Screenshot Capture

Deterministic, scripted capture of every screen and state of a web app, on
the device types you choose, with change detection so only what moved gets
re-captured, and documentation generated from the result.

One engine, many apps. Everything about a particular app (its URL, hosts,
login form, accounts, flows, PII rules) lives in an **app profile** under
`apps/<app-id>/`. The engine itself knows nothing about any app.

---

## What this is

A run picks one app profile, signs in with the accounts the profile names,
walks that app's scripted flows on each selected device (Laptop, Mobile,
Tablet), screenshots each step and writes a manifest of what it saw. It then
compares that against last time:

- **Skipped before a browser opens** — flows whose app source did not change
  (git diff of the app repo, optional).
- **Fingerprinted** — every captured step hashes a normalised DOM skeleton and
  compares it to the app's baseline, so `changed` means something moved.

And, separately, without a browser: **coverage** — every interactive element
(test id) and every page in the app's source either has a flow that exercises
it, or an approved exception, or the check fails (see *Coverage* below).

**Deliberately not agentic.** Every step is a line in a YAML manifest. An LLM
is used in exactly three places, none of them in the execution loop:
bootstrapping manifests, naming new nav items found by discovery, and writing
doc prose for modules that changed.

---

## Onboard a new app in 10 minutes

```bash
npm install                                   # once; installs Chromium too
cp -r apps/_template apps/my-app              # 1. copy the template
#   2. edit apps/my-app/app.config.json        — appName, appDescription, baseUrl,
#      allowedHosts, loginAdapter + selectors, accounts (see the $comment keys)
cp apps/my-app/.env.example apps/my-app/.env  # 3. fill in the credentials
#   4. write flows in apps/my-app/flows/, or record them:
npm run record -- --app my-app --flow home.dashboard
npm run record:convert -- --app my-app --flow home.dashboard
#      …review the generated draft, then promote it (see flows/_SCHEMA.md)
npm run validate -- --app my-app              # 5. offline check, no browser
npm run capture -- --app my-app --device Mobile --flow home/home-overview --headed
npm run capture -- --app my-app --all-devices # 6. the real run
#   7. coverage: add a `source` block to app.config.json, point APP_REPO_PATH_MY_APP at a clone, then
npm run coverage -- --app my-app --register-routes   # pages the source has, into known_routes.json
npm run coverage -- --app my-app --init-baseline     # today's uncovered items, recorded as debt
npm run audit:coverage -- --app my-app               # from now on, anything NEW must get a flow
```

What to fill in, and why:

| File | What goes in it |
|---|---|
| `app.config.json` | App name and one-line description (used in doc and LLM prompts), `baseUrl`, `allowedHosts` (the safety gate refuses anything else), `framework` and `theme`, `loginAdapter` (`email-password`, `username-password`, `mobile-pin` or `pin-only`) with its selectors, `accounts` (identity → the `.env` names of its login and secret), optional `dummyAccount`, optional `source` (where the app's code is, for coverage) |
| `.env` | That app's credentials, nothing else. Gitignored. The **only** place credentials are read from |
| `flows/*.yaml` | One file per path through the app — `<module>.<flow>.yaml` |
| `config/routes.map.json` | Module → app source globs, for the git-diff skip filter |
| `config/known_routes.json` | The app's page inventory, for the page check and discovery |
| `config/coverage-exceptions.json` | Approved exceptions: an element or page that stays out of the flows, with a reason (written by a person) |
| `config/coverage-baseline.json` | The adoption backlog: what was uncovered when coverage was switched on. Only ever shrinks |
| `config/pii-regions.json`, `config/manual-review-items.json` | Evidence-mode (user manual) PII classification; the template's are a valid start |
| `fingerprints/` | Written by runs: `baseline.json` (accepted DOM hashes), `last-run.json` |

App profiles are **committed** — `app.config.json`, `flows/` and `config/` are
what CI audits, and none of them holds a secret. What stays on the capturing
machine (gitignored): `.env` (credentials), `.auth/` (saved sessions),
`fingerprints/`, `recordings/` and generated `docs/`. The registered apps and
what each still needs are listed in [`docs/REGISTERED-APPS.md`](docs/REGISTERED-APPS.md).

---

## Selecting the app

Every command needs an app, and there is no default:

```bash
npm run capture -- --app my-app       # or
APP=my-app npm run capture
```

With neither, the command stops with the list of profiles that exist.

---

## Safety model

**Real accounts are read-only, permanently.** A flow signed in as any account
other than `dummy` may not create, send, upload, delete or change anything.
`npm run validate` refuses a flow that declares a write (`creates_data`,
`run_tag: true`, `writes: true`) unless it is an explicit dummy write flow.

**The host gate.** The target host must be in the profile's `allowedHosts`
(https, or localhost). A typo cannot point a browser holding real credentials
at something unexpected.

**Credentials** come only from `apps/<app-id>/.env`. A credential variable set
in the shell or the root `.env` is ignored, with a warning. Every login and
secret is redacted from run manifests, logs and generated docs.

### Dummy-account writes

Each app may have a **dummy account in its own separate test tenant**, which
makes the pages behind a write (confirmations, "record created" states,
registration steps) reachable. A flow may write only when **all** of these
hold:

1. `WRITE_MODE=dummy` (in `apps/<app-id>/.env` or the shell);
2. the flow declares `writes: true` **and** `auth: dummy`;
3. after sign-in, the tenant id **and** name the app shows match
   `dummyAccount.fingerprint` in the profile **exactly**;
4. the host is in `writeAllowedHosts`.

With `WRITE_MODE` off, write flows are skipped with a reason. With it on, any
failed gate **aborts the whole run before the first action**, and the dummy
identity is checked before any flow runs.

Data hygiene, enforced by validate and the executor:

- every value that creates a record contains `{{RUN_TAG}}` (the run id), so
  all a run created can be found again;
- a write flow must have a `teardown`, and a teardown step acts only while the
  run tag is on screen, so it can only delete records this run made, never
  the tenant's seed data;
- contact data is synthetic: emails on reserved domains (`@example.com`),
  obviously fake phone numbers (555-01xx, a repeated digit, or listed in
  `dummyAccount.syntheticPhones`);
- a write flow that declares `sends_messages` (email/SMS/WhatsApp/push) is
  skipped and **flagged in the run summary** unless the profile says the dummy
  tenant's messaging is off (`dummyAccount.messagingSuppressed: true`).

On dummy flows the evidence privacy check still runs, but email/phone shapes
are warnings, not blockers: the data is synthetic. Credentials remain errors
everywhere.

---

## Running

```bash
npm run capture -- --app my-app                          # asks which devices (or DEVICES=…)
npm run capture -- --app my-app --all-devices
npm run capture -- --app my-app --device Laptop --device Mobile
npm run capture -- --app my-app --dry-run                # plan only: no browser, no network
npm run capture -- --app my-app --force                  # ignore the skip filter
npm run capture -- --app my-app --module settings        # one module
npm run capture -- --app my-app --flow home/home-overview
npm run capture -- --app my-app --headed                 # watch it work
```

Output:

```
runs/<app-id>/<run-id>/
  run-summary.json                               totals, write mode, run tag, flagged flows
  <Laptop|Mobile|Tablet>/
    <module>-<flow>.flow-run.json                what each step did
    <module>/<flow>/<step>.<mode>.png            viewport | full | element | failed | loading
```

`runs/` is gitignored and pruned after `RUNS_RETENTION_DAYS` (default 30). The
first run of a flow on a device establishes its fingerprint baseline (every
step `new`); after that, `changed` means something moved. Review the
screenshots, then accept with `npm run baseline:accept -- --app my-app`.

Other commands (all take `--app <id>`):

```bash
npm run coverage          # test-id and page coverage of this app's source (static, offline)
npm run audit:coverage -- --app all   # the same for every registered app, plus validate, with a summary
npm run discover          # tap the app's navigation, draft flows for new routes
npm run docs              # regenerate apps/<id>/docs/<Device>/<module>.md for changed modules
npm run docs -- --all
npm run record -- --flow <module>.<flow> [--as <identity>]
npm run record:convert -- --flow <module>.<flow>
npm run record:diff -- --flow <module>.<flow>
npm run capture:evidence  # user-manual evidence run → evidence/<app-id>/<run-id>/
npm run evidence:check    # C1 acceptance check of an evidence run
npm run prune             # apply the retention policy
npm run typecheck
npm test                  # offline; runs against a synthetic "Sample App" profile
```

---

## Sign-in

The profile's `loginAdapter` decides how accounts sign in, once per identity
per run; the session is saved in `apps/<app-id>/.auth/` and reused.

| Adapter | Flow | Selectors |
|---|---|---|
| `email-password` | email → (optional Next) → password → submit | `email`, `password`, `submit`, `signedIn`; optional `next`, `error` |
| `username-password` | same, with a username | `username`, `password`, `submit`, `signedIn`; optional `next`, `error` |
| `mobile-pin` | mobile number → Continue → a PIN that submits itself on the last digit | `phone`, `continue`, `pin`, `signedIn`; optional `mustChangePin`, `submit` (a Verify button pressed after the last digit) |
| `pin-only` | a PIN and nothing else — the PIN is the identity — submitting itself on the last digit | `pin`, `signedIn`; optional `key` (keypad button template with `{digit}`, pressed instead of typing), `error`, `mustChangePin` |

A `pin-only` account has no `userEnv`, only `secretEnv`. Any account may set
`loginPath` when an app has one sign-in screen per surface (an owner console and
a staff handset), and `isAuthenticated` checks that path for that account.

`signedIn` is an element that exists only when signed in; it is how a saved
session is recognised. Framework-specific behaviour switches on from the
profile only: with `framework: react-native-web`, form logins type key by key
(controlled inputs there ignore `fill()`); `mobile-pin` always does.

Flows with `auth: none` get a fresh signed-out browser context, for capturing
the sign-in screens themselves.

---

## Flows and selectors

The complete field reference (every action, assertion, capture mode,
interpolation, the write fields) is [`flows/_SCHEMA.md`](flows/_SCHEMA.md).

Only `[data-testid="…"]` and Playwright `role=<role>[name="…"]` selectors are
allowed, enforced by `npm run validate`. Where a control has neither, the step
takes a `selector_exempt` with a reason and validate warns on every run; the fix
is a test id in the app repo. [`docs/SELECTOR-GAPS.md`](docs/SELECTOR-GAPS.md)
explains how to keep the list of asks per app.

---

## Coverage

Two static checks, no browser and no credentials, against a local clone of the
app's source (the profile's `source` block says where and how to read it):

- **Test ids** — every interactive element (by tag, handler, role, or a
  component forwarding its id to one) must be **exercised** by an executable
  flow step: a click, tap, type, fill, select, check or press on it. A waitFor,
  an assertion, a hover, a mask or a mention in a description only *locates* it
  and does not count.
- **Pages** — every page the router's file conventions define (Next.js App
  Router, Expo Router) must be in `known_routes.json`, must still exist, and
  must be visited by a flow (`goto` or a `url_contains` assertion).

Anything uncovered must be either on the app's **adoption backlog** (what was
uncovered when the check was switched on; it can only shrink) or an **approved
exception** with a written reason in `config/coverage-exceptions.json`.
Everything else — a NEW element, a NEW page, a flow pointing at an id or a
path that no longer exists, an expired or no-longer-needed exception — fails.

```bash
APP_REPO_PATH_MY_APP=~/code/my-app npm run coverage -- --app my-app
npm run audit:coverage -- --app all            # exit 0 PASS · 1 FAIL · 2 CONFIG · 3 BLOCKED
npm run audit:coverage -- --app my-app --evidence   # count what recorded runs actually pressed
```

`.github/workflows/coverage-audit.yml` runs it for every registered app on pull
requests, on pushes to `main` and nightly, with a job summary and the JSON
reports as artifacts. It reads the app list from the profiles, so a new app
needs no workflow edit. The full reference covers what is detected and what
cannot be, exceptions, interpreting failures, CI access and cost:
[`docs/COVERAGE.md`](docs/COVERAGE.md).

Coverage and the visual baseline are separate: a changed fingerprint does not
prove a feature was exercised, and `baseline:accept` never changes coverage.

---

## Change detection

1. **git diff of the app repo** (`src/change-detector.ts`), when the profile has
   `repoPath` (or `APP_REPO_PATH` in the app `.env`). `config/routes.map.json`
   maps each module to the source globs that can affect it; no matching change
   since the last successful run means the module is skipped. `_global` paths
   invalidate every module.
2. **DOM fingerprint** (`src/fingerprint.ts`), keyed
   `<Device>/<module>/<flow>/<step>` in `apps/<app-id>/fingerprints/baseline.json`.

---

## Layout

```
apps/_template/     the documented starting point for a new app profile (committed)
apps/<app-id>/      one profile per app: app.config.json, flows/, config/ (committed); .env, .auth/, fingerprints/ (local)
config/devices.json device profiles shared by every app (Mobile, Tablet, Laptop)
flows/_SCHEMA.md    the flow manifest reference
src/                the engine
src/coverage/       test-id and page coverage: scanner, route strategies, exceptions, engine, reports
src/__tests__/      offline tests, against the synthetic Sample App profile and the coverage fixture apps
reports/            coverage output: reports/<app-id>/coverage.json, reports/audit-summary.{json,md} (gitignored)
.github/            the coverage-audit workflow and its app-matrix script
runs/               output: runs/<app-id>/<run-id>/<Device>/…  (gitignored)
evidence/           evidence-mode output: evidence/<app-id>/<run-id>/  (gitignored)
docs/               project documentation
```

Scheduling: anything that can run `npm run capture -- --app <id>` on a
schedule works — a cron on a machine that holds the app profile, or a CI job
that writes `apps/<id>/.env` from secrets.
