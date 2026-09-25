# 1_UserManual — how to run this project

Operating manual for the RosiFit screenshot-capture and evidence pipeline: what to
install, what to supply, which commands to run in which order, and where every
output lands.

Written for the person running the capture (an operator or engineer who has a
terminal and a real RosiFit account).

> **Scope today.** This instance captures **one application** (the RosiFit PWA)
> on **one device profile** (a 390x844 phone at 2x). It does not ask which device
> types you want, cannot capture laptop or tablet form factors truthfully, and
> cannot prove it visited every page the app repo defines. See
> [docs/PROPOSAL-any-app-any-device.md](docs/PROPOSAL-any-app-any-device.md)
> and the *Limits* section at the end.

> **Read-only, always.** Flows may open, filter, search and type, but must never
> save, send, upload, delete or register. `npm run validate` enforces what it can
> see; the rest is your review.

---

## 1. Prerequisites

| # | Requirement | How to check / get it |
|---|---|---|
| 1 | Node.js 20 or newer | `node -v` |
| 2 | Dependencies + Chromium | `npm install` (the `postinstall` hook installs Playwright's Chromium) |
| 3 | A real RosiFit account (super admin) | 10-digit mobile number + 4-digit PIN |
| 4 | That account is **not** in "must change PIN" state | If it is, sign in by hand once in a normal browser and set the PIN, then re-run |
| 5 | Network access to `https://rosi-fit.vercel.app` | — |
| 6 | *Optional:* a clone of the app repo | Enables the git-diff skip filter; without it every flow simply runs |
| 7 | *Optional:* staff account | Only needed for flows declaring `auth: staff` |

Verify the setup before the first capture:

```bash
npm run typecheck && npm test && npm run validate
```

---

## 2. Inputs

### 2.1 `.env` (required — never committed)

Copy `.env.example` to `.env` and fill it in.

| Variable | Meaning | Default |
|---|---|---|
| `APP_URL` | The app to capture | `https://rosi-fit.vercel.app` |
| `ALLOWED_APP_HOSTS` | Safety gate allowlist; a host outside it aborts the run | `rosi-fit.vercel.app,localhost,127.0.0.1` |
| `SIGNIN_MOBILE` / `SIGNIN_PIN` | Super-admin credentials. **Secrets** — redacted from every manifest, log and doc | *(empty)* |
| `STAFF_MOBILE` / `STAFF_PIN` | Staff credentials; `auth: staff` flows are skipped without them | *(empty)* |
| `FIXED_COURSE_ID` / `FIXED_MEMBER_ID` | Pin flows to one record so new data cannot shift what is captured | *(empty)* |
| `APP_REPO_PATH` / `APP_REPO_BRANCH` | Local clone of the app repo for change detection. On Windows use forward slashes and **no quotes** | *(empty)* / `main` |
| `RUNS_RETENTION_DAYS` | Age at which `runs/` entries are pruned | `30` |
| `HEADLESS` | `false` to watch the browser | `true` |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | Capture viewport | `390` / `844` |
| `DEVICE_SCALE_FACTOR` | Pixel density; the C1 gate enforces it on every frame | `2` |
| `COLOR_SCHEME` | Emulated OS theme (`dark` / `light`) | `dark` |
| `SLOW_MO_MS`, `STEP_TIMEOUT_MS` | Pacing and per-step timeout | `0`, `15000` |
| `ANTHROPIC_API_KEY`, `LLM_MODEL` | Optional, for generated doc prose and discovery drafts | *(empty)*, `claude-sonnet-5` |
| `DISCOVERY_LLM_SEND_PAGE_CONTENT` | Keep `false` — `true` would send page HTML (with member data) to an LLM | `false` |

### 2.2 Flow manifests — `flows/{module}.{flow}.yaml`

One file per flow; the unit of work. Schema reference: [flows/_SCHEMA.md](flows/_SCHEMA.md).
Worked example: [flows/attendance.course-detail.yaml](flows/attendance.course-detail.yaml).

### 2.3 Config files — `config/`

| File | Purpose | Who edits it |
|---|---|---|
| `routes.map.json` | Module → flows → app source paths. A flow's `module` must exist here | You, when adding a module |
| `known_routes.json` | Routes discovery knows about | `npm run discover`, or you |
| `pii-regions.json` | Capture-time PII classification: data regions and the label allowlist | You, after reviewing `label-review.txt` |
| `manual-review-items.json` | Open questions carried into the evidence index for a human to settle | You, when resolving an item |

---

## 3. Templates

### 3.1 New flow (`flows/{module}.{flow}.yaml`)

```yaml
schema_version: 2
module: attendance            # must be a key in config/routes.map.json
flow: my-flow                 # must be listed under that module's `flows`
title: Short human name       # required in v2
description: One line; appears in the generated docs.
scenario_class: happy         # happy | validation | duplicate | empty | permission | offline
auth: admin                   # admin | staff | none
audience: academy owner
settle_ms: 600

depends_on_routes:
  - /courses

steps:
  - id: 010-open-list         # numbered, hand-assigned: the id is the filename stem
    action: goto
    value: /courses
    label: The course list
    screenshot: false
    settle_ms: 1200
    assert:
      selector_visible: '[data-testid="courses-add"]'

  - id: 020-open-form
    action: click
    selector: '[data-testid="courses-add"]'
    label: Add Course — the empty form (never saved)
    expect_screen: course-form-empty     # names the screen; C2 needs this to make the frame canonical
    screenshot: full                     # viewport | full | auto | element:<selector> | false
    optional: false                      # true = a failure here is recorded and the flow continues
    assert:
      selector_visible: '[data-testid="course-close"]'
```

Rules worth knowing before you write one:

- **`expect_screen` is what names a screen.** Without it, C2 cannot make the
  frame canonical evidence — it will not invent a name.
- **`optional: true`** keeps a flaky or conditional step from failing the flow. It
  is then excluded from required coverage.
- **Any `type`/`fill` step needs `run_tag: false`**, asserting the value creates no
  record. `run_tag: true` is a hard validation error — this project never writes.
- Selectors should be `data-testid` based. An exemption needs `selector_exempt`
  with a reason, and `validate` warns about it on every run.

### 3.2 New PII data region (`config/pii-regions.json`)

```json
{ "id": "course-branch-field", "class": "O", "match": { "testid": "course-branch-field" } }
```

`class`: `P` member/customer data · `O` organisation data · `I` operator identifier.
`match`: `testid`, or `testid_family` (ending `-*`), or `role` + `name_regex`.

### 3.3 New review item (`config/manual-review-items.json`)

```json
{
  "id": "R-C2-003",
  "topic": "short-slug",
  "status": "open",
  "origin": "where the question came from",
  "question": "The decision a human has to make.",
  "match": { "texts": ["exact text as captured"] },
  "resolution": null
}
```

To close one: set `status` to `resolved`, write the decision in `resolution`, and
rebuild the index.

---

## 4. The procedure

### Step 0 — Validate (always, before anything else)

```bash
npm run validate
```

Checks every manifest against the schema, the selector policy and the read-only
rule. **Fix all errors before capturing.** Nothing is written.

### Step 1 — Plan without a browser (optional)

```bash
npm run capture:dry
```

Prints which flows would run and why. No browser, no writes to the app.

### Step 2 — Routine capture

```bash
npm run capture                      # only flows whose app code changed
npm run capture:all                  # every flow, ignoring the skip filter
npm run capture:module -- attendance # one module
npm run capture -- --flow attendance/course-detail --headed
```

Writes `screenshots/`, `runs/`, and updates `fingerprints/`. **The git diff of
`screenshots/` after a run is the change signal:** an empty diff means nothing
moved.

If a change is real and expected, accept it as the new normal:

```bash
npm run baseline:accept                 # everything
npm run baseline:accept -- --module attendance   # one module
```

### Step 3 — Evidence run (the input to the manual pipeline)

```bash
npm run capture:evidence -- --flow signin/sign-in-journey --flow attendance/courses-workspace --flow attendance/course-detail
```

Runs every selected flow regardless of the skip filter and writes **only** into
`evidence/<run_id>/`. `screenshots/`, `runs/` and the fingerprint baseline are
never touched. Note the run id it prints (e.g. `2026-09-15T12-13-39Z`).

### Step 4 — C1 gate: evidence check

```bash
npm run evidence:check -- --require signin/sign-in-journey,attendance/courses-workspace,attendance/course-detail
```

Verifies structure, privacy (no secret, identifier, email or phone anywhere),
frames, coverage and that each required flow ran. Exit 0 = PASS.

### Step 5 — C1 gate: review the labels **by hand**

Open `evidence/<run_id>/label-review.txt`. It lists every text classified as an
application label. **Nothing in it may be a person, an email, a phone number or
record data.**

If something is wrong: add a `data_region` to `config/pii-regions.json`, then
**re-run Steps 3–5**. Do not proceed until the file is clean.

### Step 6 — C2: build the evidence index

```bash
npm run evidence:index -- --run <run_id> --require signin/sign-in-journey,attendance/courses-workspace,attendance/course-detail
```

Classifies every captured frame and selects canonical evidence.

### Step 7 — C2 gate: check the index

```bash
npm run evidence:index:check -- --run <run_id> --require signin/sign-in-journey,attendance/courses-workspace,attendance/course-detail
```

Re-derives every verdict from the C1 evidence, rebuilds the index to prove it is
deterministic, and verifies coverage, provenance and privacy. Exit 0 = PASS.

Then read `evidence/<run_id>/c2/coverage.txt` and settle any open review items.

### Step 8 — Generate documentation

```bash
npm run docs
```

Writes `docs/{module}.md` from the latest run manifests and screenshots.

### Adding a new flow

```bash
npm run discover                                    # crawl navigation; drafts land in flows/_drafts/
npm run record -- --flow attendance.my-flow         # record by hand -> recordings/{module}.{flow}.json
npm run record:convert -- --flow attendance.my-flow # convert the recording into a draft manifest
npm run record:diff -- --flow attendance.my-flow    # re-record later and compare
```

Drafts are **never executed** from `flows/_drafts/`. Review, resolve every
`TODO_SELECTOR`, set `run_tag: false` on typing steps, delete the GENERATED
header, move the file to `flows/`, then `npm run validate`.

### Housekeeping

```bash
npm run prune          # drop runs/ entries older than RUNS_RETENTION_DAYS
npm test               # 185 unit tests
npm run typecheck
```

---

## 5. Outputs — what lands where

| Path | Written by | Contents | Commit? |
|---|---|---|---|
| `screenshots/{module}/{flow}/{step}.{mode}.png` | `capture` | `mode` = `viewport`, `full`, `element`, `failed`, `loading` | Yes — the diff is the signal |
| `runs/{YYYY-MM-DD}/{module}-{flow}.flow-run.json` | `capture` | Step-by-step record of the run | Yes |
| `runs/{YYYY-MM-DD}/run-summary.json` | `capture` | Totals for the run | Yes |
| `fingerprints/baseline.json` | `capture`, `baseline:accept` | Accepted DOM hash per step | Yes |
| `fingerprints/last-run.json` | `capture` | Last successful run and app SHA | Yes |
| `docs/{module}.md` | `docs` | Screenshot-illustrated walkthrough | Yes |
| `recordings/{flow}.json` | `record` | Raw recording | Yes |
| `flows/_drafts/*.yaml` | `discover`, `record:convert` | Unreviewed drafts, never executed | Review first |
| `config/known_routes.json` | `discover` | Routes discovery has seen | Yes |
| `.auth/*.json` | sign-in | Live session state — **secret** | **Never** |

### Evidence run — `evidence/<run_id>/`

Gitignored: raw frames can contain personal data.

| Path | Contents |
|---|---|
| `{module}/{flow}/{step}.pre.png` / `.post.png` | Evidence frames, before and after each step |
| `{module}/{flow}/{step}.evidence.json` | Classified census, inventory, target, URL, visual state, assertions |
| `screenshots/{module}/{flow}/{step}.{mode}.png` | The executor's documentation shots for this run |
| `runs/{module}-{flow}.flow-run.json` | Flow manifests for this run |
| `run-summary.json`, `evidence-summary.json` | Run totals; frame and class counts |
| **`label-review.txt`** | **Every text classified as a label — the file you review by hand (Step 5)** |
| `evidence-check.json` | C1 gate result |
| `c2/evidence-index.json` | The Evidence Index: every frame, classified, with provenance |
| `c2/coverage.txt` | Human-readable coverage and canonical choices |
| `c2/index-check.json` | C2 gate result |

---

## 6. Order of operations, at a glance

```
validate → capture:dry → capture ─────────────────────→ docs
                             │
                             └→ capture:evidence → evidence:check → label-review.txt (human)
                                                        │
                                                        └→ evidence:index → evidence:index:check
```

A gate that fails stops the line. Fix the cause, re-run from the capture step.

---

## 7. Limits you should know about

1. **One application, onboarded by hand.** The safety gate, sign-in (mobile +
   4-digit PIN, with hard-coded selectors), interstitials, discovery and the PII
   patterns are RosiFit-specific. Onboarding another app you own currently means
   forking the repo and editing code.
2. **No proof that every page was captured.** `config/known_routes.json` is
   hand-maintained: it lists 20 routes, while the app repo defines 31 route files.
   Nothing compares the two, so a page added to the app is missed silently.
   `npm run discover` only finds pages reachable from the live navigation.
3. **One device profile, never asked for.** Every run emulates a Pixel 7 phone.
   Changing `VIEWPORT_WIDTH` resizes the window but the context still reports a
   mobile user agent and touch support, so a "laptop" capture is not a truthful
   one. Outputs carry no device folder, so a second device would overwrite the
   first and collide with the fingerprint baseline.
4. **Canonical is not publishable.** In the evidence index, `canonical` means
   "the right frame to use". Frames flagged `redaction-required` still contain
   personal data and must be redacted before anyone outside sees them.
5. **Sign-in touches a real account.** Capture is otherwise read-only.

Limits 1-3 are addressed in
[docs/PROPOSAL-any-app-any-device.md](docs/PROPOSAL-any-app-any-device.md),
awaiting your review: device types you are asked to choose (written to
`screenshots/{Device}/{module}/...`), a route inventory generated from the app
repo, and a page-coverage report.
