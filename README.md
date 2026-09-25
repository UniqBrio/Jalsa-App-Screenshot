# RosiFit App Screenshot Capture

Deterministic, scripted, **read-only** capture of every screen and state in the
RosiFit web PWA (https://rosi-fit.vercel.app), with change detection so that
only what actually moved gets re-captured — and documentation generated from
the result.

Cloned from `UniqBrio_App_Screenshot_Capture` and re-pointed at RosiFit. Same
engine, same flow schema, same output layout; different app, different login,
and one rule that is stricter here than there (see *Read-only, always*).

---

## What this is

Each run signs in to the live RosiFit app as the super admin, walks a set of
scripted flows, screenshots each step, and writes a manifest of what it saw. It
then compares what it saw to last time. Screens that did not change cost
nothing — they are skipped before a browser even opens, based on a git diff of
the app repo. Screens that did change produce a new screenshot, a flagged run
manifest, and eventually a regenerated documentation page.

The output is three things that live in this repo and are meant to be committed:

`screenshots/` — the current visual state of every captured screen.
`runs/` — what happened on each run, step by step.
`docs/` — human-readable, screenshot-illustrated documentation per module.

The git diff of this repo after a run is the signal. If nothing shows up in
the diff, nothing in the app changed.

**Deliberately not agentic.** Every step is a line in a YAML manifest. An LLM is
used in exactly three places, none of them in the execution loop: bootstrapping
manifests, naming genuinely new nav items found during discovery, and writing
doc prose for modules that changed. That constraint is what makes
run-over-run change detection meaningful rather than a coin flip.

### Read-only, always

RosiFit has one deployment and one Supabase project. There is no TEST
environment, so unlike the UniqBrio project this one captures the **live app
with real data**, and the rule that replaces "TEST only" is:

- No flow may save, send, upload, delete, register, or change a setting stored
  on the account. Forms are opened and closed; dropdowns are opened and
  dismissed; search boxes are typed into and cleared. That is the whole
  vocabulary.
- `npm run validate` refuses any flow that declares a write (`creates_data`,
  `run_tag: true`, a leftover `cleanup` block). There is no cleanup module in
  this repo, because there must never be anything to clean up.
- The safety gate in `src/env.ts` refuses to start unless `APP_URL` is on the
  host allowlist, so a typo can never point a browser holding a real PIN at
  something unexpected.
- The PIN and the sign-in mobile numbers are redacted from every run manifest,
  log line and generated doc before it is written (`redactSecrets` in
  `src/env.ts`). `.env` and `.auth/` — the saved session — are gitignored, and
  `.env.example` holds placeholders only.

Things the flows deliberately never touch, because they act on real people:
**Sign out**, **Send** (`send-trigger`), **Upload** (choosing a file),
**Reach out** from the weekly review, **Add / Save / Remove** on any form,
**Export** on Reports, and the theme / accent choices under Appearance (those
are saved to the account and follow the user to other devices).

---

## Prerequisites

Node.js 20 or newer, plus npm. Everything else installs from `package.json`.

You will also want a clone of the app repo on the same machine —
https://github.com/UniqBrio/RosiFit — so the git-diff change detector can work.
It is optional: without it, detection falls back to DOM fingerprinting alone
and every flow runs every time.

Values you need before the first run: the super admin's mobile number and
4-digit PIN. The number is a sign-in ID (the app shows it on the PIN screen);
the PIN is a secret and lives only in your local `.env`.

---

## Setup

```bash
npm install                # also installs the Chromium build Playwright needs
cp .env.example .env       # then fill in SIGNIN_PIN (and APP_REPO_PATH if you have the clone)
npm run validate           # offline check: manifests, config, env gate
```

`npm run validate` touches no network and opens no browser. It parses every flow
manifest, cross-checks them against `config/routes.map.json`, confirms no flow
declares a write, reports routes with no flow coverage, and runs the
environment safety gate. Run it before every commit.

The `.env` values worth understanding:

`SIGNIN_MOBILE` / `SIGNIN_PIN` — the super admin. `STAFF_MOBILE` / `STAFF_PIN`
are optional; flows with `auth: staff` are skipped with a reason until both are
set. `APP_REPO_PATH` points at the RosiFit app clone; leave it blank and the
git-diff skip filter simply switches off. `FIXED_COURSE_ID` / `FIXED_MEMBER_ID`
are optional pins for flows that otherwise take "the first course card".
`RUNS_RETENTION_DAYS` defaults to 30.

---

## Running locally

```bash
npm run capture                                # the full run
npm run capture -- --dry-run                   # plan only: no browser, no network
npm run capture -- --force                     # ignore the skip filter, run everything
npm run capture -- --module more               # one module
npm run capture -- --flow overview/overview-home
npm run capture -- --headed                    # watch it work
```

Start with `--dry-run`, then one flow with `--headed` so you can watch
(`--flow overview/overview-home` is the cheapest), and only then run the lot.
The first full run establishes the fingerprint baseline; every step reports
`new`. From the second run on, `changed` means something moved.

**These flows were written from the app's source, not against the live app.**
Every selector is a `testID` or an `accessibilityRole` + `accessibilityLabel`
read from `app/**` and `src/components/**` in the RosiFit repo as of
2026-09-12. They have not yet been run against rosi-fit.vercel.app (the
environment this project was built in could not reach it). Expect the first
headed run to surface a few mismatches — a label that differs by a word, a
dropdown that needs a longer settle — and fix them in the manifest, never by
swapping in a CSS selector. Steps most likely to need a look are marked
`optional: true` so one of them cannot fail a whole flow.

Other commands:

```bash
npm run record -- --flow members.member-filters       # walk a scenario once, headed
npm run record:convert -- --flow members.member-filters   # -> flows/*.generated.yaml draft
npm run record:diff -- --flow members.member-filters      # read-only drift check
npm run discover          # tap through the shell's nav, propose drafts for anything new
npm run docs              # regenerate docs for modules flagged changed
npm run docs -- --all     # regenerate everything
npm run baseline:accept   # accept the latest run's DOM as the new baseline
npm run prune             # apply the runs/ retention policy
npm run typecheck
npm test
```

---

## How sign-in works

RosiFit signs in with a mobile number and a PIN on one screen (`/`). Continue
asks the server whether the number is registered; a known number moves to the
PIN step, which submits itself on the fourth digit. There is no OTP and no
Verify button. `src/login.ts` drives exactly that, once per identity per run,
and saves the browser's storage state so every later flow reuses the session.

`/` is also the Overview: the sign-in screen asks the server whether a session
is already live and, if so, replaces itself with the shell. That is why the
saved-session check is DOM-based (is the academy header there?) rather than
URL-based, and why the sign-in flows declare `auth: none` — the runner gives
each of them a fresh, signed-out browser context so the number field actually
appears.

---

## The flows

Twenty read-only flows across twelve modules, one YAML file each in `flows/`:

| module | flows | what they capture |
|---|---|---|
| `signin` | `sign-in-journey`, `forgot-pin` | number entry (incomplete and complete), the PIN step, the landing on Overview; change-number and the Forgot PIN screen |
| `overview` | `overview-home` | the dashboard, each of its three filter panels, the three attendance sections, the jump to weekly review |
| `attendance` | `courses-workspace`, `course-detail`, `attendance-register` | the course list and its Add / Edit forms (opened, closed); one course's week strip, dropdowns, search and a member; the records list and its four filters |
| `members` | `member-directory`, `member-detail` | a course roster, the whole directory, search, the Add form; one member's two tabs, Reach out (cancelled), Edit (cancelled) |
| `weekly` | `weekly-review` | the follow-up list and one flagged member |
| `reports` | `reports-overview` | the period filter and each scope |
| `notifications` | `notification-panel` | the bell and its sheet |
| `more` | `more-menu`, `profile`, `branches`, `appearance`, `help` | the settings menu and each screen under it; Change My PIN captured empty |
| `staff` | `staff-access` | the staff list and the Add staff form (closed) |
| `audit` | `audit-log` | the log and its filters |
| `upload` | `upload-attendance` | the upload dialog's first step, no file chosen |
| `send` | `send-communication` | the recipient picker, searched, cancelled |

The complete field reference — every action, every assertion type,
interpolation, and the selector policy — is in [`flows/_SCHEMA.md`](flows/_SCHEMA.md).

### Selector policy

Only `[data-testid="…"]` (with `^=`, `*=`, `$=`) and Playwright
`role=<role>[name="…"]` selectors are allowed, enforced as a hard error by
`npm run validate`. RosiFit is React Native for web, so a component's `testID`
reaches the DOM as `data-testid` and its `accessibilityRole` + `accessibilityLabel`
as `role` + `aria-label` — both forms map straight onto the app source. Where a
control has neither, the step takes a `selector_exempt` with a reason and
validate warns on every run; the right fix is a `testID` in the app repo, and
`docs/SELECTOR-GAPS.md` is the place to record the ask.

---

## Change detection

Two layers:

1. **git diff of the app repo** (`src/change-detector.ts`). `config/routes.map.json`
   maps each module to the app source paths that can affect it (taken from the
   real expo-router layout: `app/(tabs)/index.tsx` for Overview, `app/course/**`
   for the course screens, and so on). No matching change since the last
   successful run means the module is skipped for zero cost. Anything under
   `_global` (the shell, the theme, the session code) invalidates every module.
2. **DOM fingerprint** (`src/fingerprint.ts`). Every captured step hashes a
   normalised DOM skeleton and compares it to `fingerprints/baseline.json`.
   Review the changed screenshots, then `npm run baseline:accept`.

The first layer is what makes a daily schedule affordable; the second is what
catches a change the diff could not attribute.

---

## Scheduling

Anything that can run `npm run capture` on a schedule and commit the result
works: a cron on a machine with the `.env`, or a CI job with `SIGNIN_MOBILE`
and `SIGNIN_PIN` as secrets and a checkout of the app repo at `APP_REPO_PATH`.
Commit `screenshots/`, `runs/`, `fingerprints/` and `docs/` after each run —
they are the product. Never commit `.env` or `.auth/`.

---

## Layout

```
flows/            one YAML per flow; _SCHEMA.md is the reference
config/           routes.map.json (module -> app source paths), known_routes.json (nav baseline)
src/              the engine — runner, executor, login, screenshot, fingerprint, discovery, docs
src/__tests__/    offline unit tests (npm test)
screenshots/      output: screenshots/{module}/{flow}/{step}.{mode}.png
runs/             output: runs/{date}/{module}-{flow}.flow-run.json + run-summary.json
fingerprints/     baseline.json (accepted DOM hashes), last-run.json (skip-filter state)
recordings/       structured logs from `npm run record` (committed, redacted)
docs/             generated documentation per module
```
