# 1_UserManual — how to run this project

Operating manual for the screenshot-capture and evidence pipeline: what to
install, what to supply, which commands to run in which order, and where every
output lands.

Written for the person running a capture (an operator or engineer with a
terminal and accounts on the app being captured).

> **One engine, many apps.** Everything about the app you capture lives in its
> profile, `apps/<app-id>/`. Every command below takes `--app <app-id>` (or
> `APP=<app-id>`); there is no default app. Examples use `my-app`.

> **Read-only for real accounts.** Flows signed in as a real account may open,
> filter, search and type, but never save, send, upload, delete or register.
> Only the dummy account, in its own test tenant, may write, and only when every
> write gate holds (§4.3).

---

## 1. Prerequisites

| # | Requirement | How to check / get it |
|---|---|---|
| 1 | Node.js 20 or newer | `node -v` |
| 2 | Dependencies + Chromium | `npm install` (the `postinstall` hook installs Playwright's Chromium) |
| 3 | An app profile | `apps/<app-id>/app.config.json` — copy `apps/_template` (§2.1) |
| 4 | Credentials for each account the profile names | In `apps/<app-id>/.env` only |
| 5 | Network access to the app's `baseUrl` | — |
| 6 | *Optional:* a clone of the app repo | Enables the git-diff skip filter; without it every flow runs |
| 7 | *Optional:* a dummy account in a separate test tenant | Only needed for write flows (§4.3) |

Verify the setup before the first capture:

```bash
npm run typecheck && npm test && npm run validate -- --app my-app
```

---

## 2. Inputs

### 2.1 The app profile — `apps/<app-id>/`

Start from the template:

```bash
cp -r apps/_template apps/my-app
cp apps/my-app/.env.example apps/my-app/.env
```

| File | Purpose |
|---|---|
| `app.config.json` | App identity and behaviour. Every field is explained in its `$comment` keys |
| `.env` | This app's credentials. **Never committed.** The only place credentials are read from |
| `flows/<module>.<flow>.yaml` | Flow manifests |
| `flows/_drafts/` | Discovery and recorder drafts — never executed |
| `config/routes.map.json` | Module → flows → app source globs. A flow's `module` must exist here |
| `config/known_routes.json` | The app's routes; `npm run discover` adds to it |
| `config/pii-regions.json` | Evidence-mode PII classification: data regions and the label allowlist |
| `config/manual-review-items.json` | Open questions carried into the evidence index |
| `fingerprints/baseline.json`, `last-run.json` | Written by runs |
| `.auth/<identity>.json` | Saved sessions — **secret**, written by sign-in |
| `docs/<Device>/<module>.md` | Generated documentation |
| `recordings/<module>.<flow>.json` | Recorder output |

`app.config.json` essentials:

| Field | Meaning |
|---|---|
| `appName`, `appDescription` | Display name and one-line description; used in doc intros and LLM prompts |
| `baseUrl` | Where the app runs. `APP_URL` in `.env` may override it (still host-gated) |
| `allowedHosts` | The safety gate refuses any other target host |
| `writeAllowedHosts` | Hosts where dummy write flows may write (subset of `allowedHosts`) |
| `repoPath`, `repoBranch` | App repo clone for change detection (`APP_REPO_PATH` in `.env` overrides) |
| `framework` | `react-native-web`, `nextjs`, `react`, `vue`, `angular`, `svelte`, `other` — switches framework-specific behaviour |
| `theme`, `locale`, `timezone` | What the emulated browser reports |
| `loginAdapter` | `email-password`, `username-password` or `mobile-pin`, with its selectors and options |
| `accounts` | Identity → `.env` names of its login and secret; `optional: true` skips its flows when unset |
| `defaultAccount` | Identity for flows without `auth:` (never `dummy`) |
| `dummyAccount` | Expected tenant id + name after the dummy signs in, and how to read them; `messagingSuppressed` |

### 2.2 Shared settings — root `.env` (optional)

Copy `.env.example` to `.env`. Shared, app-independent settings only; no
credentials (any set here are ignored).

| Variable | Meaning | Default |
|---|---|---|
| `APP` | App profile, when not passed as `--app` | *(none — required)* |
| `DEVICES` | Device ids from `config/devices.json`, or `all` | ask, or the config default |
| `RUNS_RETENTION_DAYS` | Age at which `runs/<app-id>/` entries are pruned | `30` |
| `HEADLESS` | `false` to watch the browser | `true` |
| `COLOR_SCHEME` | Override the profile's theme | profile `theme` |
| `SLOW_MO_MS`, `STEP_TIMEOUT_MS` | Pacing and per-step timeout | `0`, `15000` |
| `ANTHROPIC_API_KEY`, `LLM_MODEL` | Optional, for doc prose and discovery drafts | *(empty)*, `claude-sonnet-5` |
| `DISCOVERY_LLM_SEND_PAGE_CONTENT` | Keep `false` — `true` sends page HTML (possibly personal data) to an LLM | `false` |

### 2.3 App `.env` — `apps/<app-id>/.env`

| Variable | Meaning |
|---|---|
| the `userEnv` / `secretEnv` of each account | Logins and secrets. **Redacted** from every manifest, log and doc |
| `WRITE_MODE` | `dummy` enables dummy write flows; anything else (default) keeps them off |
| `APP_URL` | Optional preview deployment instead of `baseUrl` |
| `APP_REPO_PATH`, `APP_REPO_BRANCH` | Optional app repo clone. On Windows use forward slashes and **no quotes** |
| any `extraEnvVars` | Values flows may interpolate, e.g. a pinned record id |

### 2.4 Devices — `config/devices.json`

Shared by every app: `Mobile` (390x844 @2x, touch), `Tablet` (820x1180 @2x,
touch), `Laptop` (1440x900 @2x, desktop browser). Adding one is one entry.

---

## 3. Templates

### 3.1 New flow (`apps/<app-id>/flows/<module>.<flow>.yaml`)

```yaml
schema_version: 2
module: settings              # must be a key in config/routes.map.json
flow: edit-profile            # listed under that module's `flows`
title: Short human name       # required in v2
description: One line; appears in the generated docs.
scenario_class: happy         # happy | validation | duplicate | empty | permission | offline
auth: admin                   # an account from app.config.json, or none
settle_ms: 600

depends_on_routes:
  - /settings

steps:
  - id: 010-open-settings     # numbered, hand-assigned: the id is the filename stem
    action: goto
    value: /settings
    label: The settings screen
    screenshot: false
    assert:
      selector_visible: '[data-testid="settings-edit"]'

  - id: 020-open-form
    action: click
    selector: '[data-testid="settings-edit"]'
    label: Edit profile — the form (never saved)
    expect_screen: profile-form        # names the screen; C2 needs this to make the frame canonical
    screenshot: full                   # viewport | full | auto | element:<selector> | false
    assert:
      selector_visible: '[data-testid="profile-cancel"]'
```

Rules worth knowing before you write one:

- **`expect_screen` is what names a screen.** Without it, C2 cannot make the
  frame canonical evidence.
- **`optional: true`** keeps a flaky or conditional step from failing the flow.
- **Every `type`/`fill` step needs `run_tag`**: `false` for a search, filter or
  sign-in field; `true` only in a dummy write flow, with `{{RUN_TAG}}` in the value.
- Selectors are `data-testid` or `role=…[name=…]`. An exemption needs
  `selector_exempt` with a reason, and `validate` warns about it on every run.

### 3.2 New dummy write flow

```yaml
schema_version: 2
module: orders
flow: create-order
title: Create an order
auth: dummy                    # the only identity that may write
writes: true                   # required on any flow that writes
sends_messages: [email]        # declare outbound messages; skipped unless the dummy tenant is muted
steps:
  - id: 010-new
    action: goto
    value: /orders/new
  - id: 020-name
    action: type
    selector: '[data-testid="order-name"]'
    value: "Order {{RUN_TAG}}"   # every created record carries the run id
    run_tag: true
  - id: 030-email
    action: type
    selector: '[data-testid="order-email"]'
    value: buyer@example.com     # synthetic contact data only
    run_tag: false
  - id: 040-save
    action: click
    selector: '[data-testid="order-save"]'
    creates_data: true
    screenshot: viewport
teardown:                        # required: delete what this run tagged
  - id: 900-open
    action: goto
    value: /orders?search={{RUN_TAG}}
  - id: 910-delete
    action: click
    selector: '[data-testid="order-delete"]'   # runs only while the run tag is on screen
```

### 3.3 New PII data region (`config/pii-regions.json`)

```json
{ "id": "customer-name", "class": "P", "match": { "testid": "customer-name" } }
```

`class`: `P` customer/member data · `O` organisation data · `I` operator identifier.
`match`: `testid`, or `testid_family` (ending `-*`), or `role` + `name_regex`.

### 3.4 New review item (`config/manual-review-items.json`)

```json
{
  "id": "R-C2-001",
  "topic": "short-slug",
  "status": "open",
  "origin": "where the question came from",
  "question": "The decision a human has to make.",
  "match": { "texts": ["exact text as captured"] },
  "resolution": null
}
```

To close one: set `status` to `resolved`, write the decision in `resolution`,
and rebuild the index.

---

## 4. The procedure

### Step 0 — Validate (always, before anything else)

```bash
npm run validate -- --app my-app
```

Checks the profile and its login adapter, every manifest against the schema,
the selector policy and the write rules, and the host gate. **Fix all errors
before capturing.** Nothing is written.

### Step 1 — Plan without a browser (optional)

```bash
npm run capture:dry -- --app my-app --all-devices
```

### Step 2 — Routine capture

```bash
npm run capture -- --app my-app --all-devices                 # flows whose app code changed
npm run capture:all -- --app my-app --all-devices             # every flow
npm run capture -- --app my-app --device Mobile --module settings
npm run capture -- --app my-app --flow settings/edit-profile --headed
```

Writes `runs/my-app/<run-id>/` and updates `apps/my-app/fingerprints/`. A step
reported `changed` means its DOM moved since the accepted baseline. If the
change is real and expected, accept it:

```bash
npm run baseline:accept -- --app my-app                     # the latest run, everything
npm run baseline:accept -- --app my-app --module settings --device Laptop
```

### Step 3 — Evidence run (the input to the manual pipeline)

```bash
npm run capture:evidence -- --app my-app --device Mobile --flow signin/sign-in-journey
```

Runs every selected flow regardless of the skip filter and writes **only** into
`evidence/my-app/<run-id>/`. `runs/` and the fingerprint baseline are never
touched. Note the run id it prints.

### Step 4 — C1 gate: evidence check

```bash
npm run evidence:check -- --app my-app --run <run-id> --require signin/sign-in-journey
```

Verifies structure, privacy (no secret, identifier, email or phone anywhere),
frames, coverage, and that each required flow ran. Exit 0 = PASS. On flows
captured as the dummy account, email/phone shapes are reported as warnings
(the data is synthetic); secrets and identifiers are errors everywhere.

### Step 5 — C1 gate: review the labels **by hand**

Open `evidence/my-app/<run-id>/label-review.txt`. It lists every text classified
as an application label. **Nothing in it may be a person, an email, a phone
number or record data.** If something is wrong, add a `data_region` to the
app's `config/pii-regions.json` and re-run Steps 3-5.

### Step 6 — C2: build and check the evidence index

```bash
npm run evidence:index -- --app my-app --run <run-id> --require signin/sign-in-journey
npm run evidence:index:check -- --app my-app --run <run-id> --require signin/sign-in-journey
```

Then read `evidence/my-app/<run-id>/c2/coverage.txt` and settle open review items.

### Step 7 — Generate documentation

```bash
npm run docs -- --app my-app
```

Writes `apps/my-app/docs/<Device>/<module>.md` from the latest run.

### 4.3 Dummy-account writes

1. The dummy account exists **in its own tenant** — never a user inside a real
   one: its records must be invisible to real users.
2. Fill in `dummyAccount.fingerprint` (the tenant id and name the app shows
   after sign-in, and where to read them), the dummy credentials in `.env`, and
   the dummy tenant's host in `writeAllowedHosts`.
3. Set `messagingSuppressed: true` only if the dummy tenant cannot send email,
   SMS or WhatsApp.
4. Run with `WRITE_MODE=dummy` in `apps/my-app/.env`.

The runner signs in as the dummy **before any flow acts** and compares the
tenant exactly. Any failed gate aborts the whole run; nothing is written.
Write flows that would send messages from an unmuted tenant are skipped and
listed under `flagged` in `run-summary.json`.

### Adding a new flow

```bash
npm run discover -- --app my-app                                 # drafts land in flows/_drafts/
npm run record -- --app my-app --flow settings.edit-profile      # record by hand
npm run record:convert -- --app my-app --flow settings.edit-profile
npm run record:diff -- --app my-app --flow settings.edit-profile
```

Drafts are **never executed**. Review, resolve every `TODO_SELECTOR`, answer
`run_tag` on typing steps, delete the GENERATED header, move the file into
`flows/`, then validate.

### Housekeeping

```bash
npm run prune -- --app my-app     # drop runs older than RUNS_RETENTION_DAYS
npm test                          # offline, against the synthetic Sample App profile
npm run typecheck
```

---

## 5. Outputs — what lands where

| Path | Written by | Contents | Commit? |
|---|---|---|---|
| `runs/<app-id>/<run-id>/<Device>/<module>/<flow>/<step>.<mode>.png` | `capture` | `mode` = `viewport`, `full`, `element`, `failed`, `loading` | No |
| `runs/<app-id>/<run-id>/<Device>/<module>-<flow>.flow-run.json` | `capture` | Step-by-step record | No |
| `runs/<app-id>/<run-id>/run-summary.json` | `capture` | Totals, write mode, run tag, flagged flows | No |
| `apps/<app-id>/fingerprints/baseline.json` | `capture`, `baseline:accept` | Accepted DOM hash per `<Device>/<module>/<flow>/<step>` | Local |
| `apps/<app-id>/fingerprints/last-run.json` | `capture` | Last successful run and app SHA | Local |
| `apps/<app-id>/docs/<Device>/<module>.md` | `docs` | Screenshot-illustrated walkthrough | Local |
| `apps/<app-id>/recordings/*.json` | `record` | Raw recording (values redacted) | Local |
| `apps/<app-id>/flows/_drafts/*.yaml` | `discover`, `record:convert` | Unreviewed drafts, never executed | Review first |
| `apps/<app-id>/.auth/*.json` | sign-in | Live session state — **secret** | **Never** |

`apps/*` except `apps/_template/` is gitignored, as are `runs/` and `evidence/`.

### Evidence run — `evidence/<app-id>/<run-id>/`

| Path | Contents |
|---|---|
| `<Device>/<module>/<flow>/<step>.pre.png` / `.post.png` | Evidence frames, before and after each step |
| `<Device>/<module>/<flow>/<step>.evidence.json` | Classified census, inventory, target, URL, visual state, assertions |
| `<Device>/screenshots/<module>/<flow>/…` | The executor's documentation shots for this run |
| `runs/<Device>/<module>-<flow>.flow-run.json` | Flow manifests for this run |
| `run-summary.json`, `evidence-summary.json` | Run totals; frame and class counts; which flows were dummy |
| **`label-review.txt`** | **Every text classified as a label — reviewed by hand (Step 5)** |
| `evidence-check.json` | C1 gate result |
| `c2/…` | The evidence index, coverage and the C2 gate result |

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

1. **No proof that every page was captured.** `known_routes.json` is maintained
   by hand and by `discover`, which only finds pages reachable from the live
   navigation. Nothing yet compares it against the app repo's route files.
2. **The C2 evidence index is not device-aware yet.** C1 evidence is written
   per device (`<Device>/…`); `evidence:index` still expects the older
   single-device layout. Run C2 on single-device evidence until it is updated.
3. **Canonical is not publishable.** In the evidence index, `canonical` means
   "the right frame to use". Frames flagged `redaction-required` still contain
   personal data and must be redacted before anyone outside sees them.
4. **Sign-in touches real accounts.** Capture with them is otherwise read-only.
5. **The phone-number shape used by the evidence PII checks is fixed** (a
   10-digit mobile with an optional country prefix). Apps whose users have
   other number formats need that pattern extended in `src/manual/`.
