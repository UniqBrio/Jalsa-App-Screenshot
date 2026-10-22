# Flow YAML schema

The reference for flow manifests, shared by every app. Each app keeps its
flows in its own profile: `apps/<app-id>/flows/`.

One file per **flow**, not per module. A module like `settings` has several —
`profile`, `team`, `billing` — plus any empty / error variants you add. Every
button, menu, tab and state you want captured becomes its own step or its own
flow.

**Real accounts are read-only.** A flow signed in as a real account may open
forms, dropdowns, dialogs and filters, and may type into search boxes and the
sign-in form — it may never save, send, upload, delete, register, or change a
setting stored on the account. `npm run validate` enforces the parts of that it
can see (`creates_data`, `run_tag: true`, `writes: true`, leftover `cleanup`
blocks); the rest is your review. The one exception is the **dummy account**:
see *Dummy write flows* below.

Filename convention: `apps/<app-id>/flows/{module}.{flow}.yaml`
(e.g. `settings.edit-profile.yaml`)

**Two schema versions coexist.** A manifest with no `schema_version` is v1 and
keeps working exactly as written — the loader normalises it into the v2 shape
internally, so there is one execution path. New flows should declare
`schema_version: 2`. `apps/_template/flows/home.home-overview.yaml` is a
minimal worked example.

---

## Flow-level fields

```yaml
schema_version: 2            # absent => 1
module: settings             # required — must exist as a key in config/routes.map.json
flow: edit-profile           # required — must be listed under that module's `flows`
title: Edit profile          # required in v2 — short human name
description: One line, shows up in generated docs
audience: account owner      # who the generated DOC is for
auth: admin                  # who the runner LOGS IN AS: an account from app.config.json, or none
writes: false                # true only for a dummy write flow — see below
sends_messages: []           # email | sms | whatsapp | push — only on a dummy write flow
devices: [Laptop, Mobile]    # optional — device ids from config/devices.json; absent = every selected device
tags: [profile, forms]
scenario_class: happy        # happy | validation | duplicate | empty | permission | offline
settle_ms: 350               # default settle after every step in this flow
disabled: false              # skip without deleting the file

depends_on_routes:           # documentation + discovery cross-check
  - /settings/profile

vars:                        # flow-local {{interpolation}}; env vars win on collision
  ROW_INDEX: "0"

setup:    [...]              # optional — runs before `steps`
steps:    [...]              # required
teardown: [...]              # optional — always runs, even after a failure
```

There is no `cleanup` block. A dummy write flow removes what it created in
`teardown`; a read-only flow has nothing to clean up.

`audience` and `auth` are deliberately separate. `auth` picks the credentials;
`audience` only labels the generated documentation.

`auth` values:

| value | what the runner does |
|---|---|
| an account name from `accounts` in `app.config.json` (e.g. `admin`) | signs in once as that account — credentials from the `.env` variables the account names — and shares the session across every flow using it, per device. Absent `auth` means the profile's `defaultAccount` |
| an `optional: true` account | the same; its flows are skipped with a reason while its credentials are unset |
| `dummy` | the dummy account in its own test tenant. After every sign-in the tenant is checked against the profile's `dummyAccount.fingerprint`; a mismatch aborts the run. The only identity that may write |
| `none` | a **fresh, signed-out** browser context for this flow alone — for the sign-in screens, which a signed-in session would skip past |

`scenario_class: offline` is a **label**. It does not put the browser offline —
the browser context is shared across every flow in a run, so a flow that went
offline and failed before restoring would poison every flow after it.

---

## Step-level fields

Every step, in every block, accepts:

| field | notes |
|---|---|
| `id` | required. `NN-kebab-case` or `NNN-kebab-case`. Also the screenshot filename stem. |
| `label` | used verbatim in generated docs. Falls back to a prettified id. |
| `action` | see the tables below |
| `selector` | supports `{{VAR}}`. Subject to the selector policy. |
| `value` | path / text / option / key / ms, depending on the action |
| `screenshot` | `viewport` \| `full` \| `auto` \| `element:<selector>` \| `false` |
| `settle_ms` | overrides the flow default for this step |
| `expect_screen` | logical screen name — documentation and fingerprint context |
| `assert` | see Assertions |
| `mask` | selectors blacked out in the PNG *and* stripped before hashing |
| `optional` | `true` = log and continue on failure |
| `creates_data` | `true` = this step writes data. A **hard error** except in a dummy write flow |
| `run_tag` | **required on `type`/`fill`**: does this value create a record? `false` for a search box, a filter, the sign-in form. `true` only in a dummy write flow, and the value must contain `{{RUN_TAG}}`. The recorder's converter emits `TODO`, which only a promoted flow rejects. |
| `selector_exempt` | reason string; see Selector policy |

**Number ids in tens** (`010`, `020`, `030`). Inserting a state later then costs
nothing. Renumbering an existing step orphans its fingerprint baseline entry
(`apps/<app-id>/fingerprints/baseline.json`), which silently throws away that step's change history.

Ids must be unique across `setup`, `steps` and `teardown` — all three share one
screenshot filename namespace.

---

## Actions

### v2 vocabulary

| action | uses `selector` | uses `value` | other fields | notes |
|---|---|---|---|---|
| `goto` | no | path, e.g. `/settings` | | relative to the profile's `baseUrl` |
| `click` | yes | — | | waits for visible first |
| `type` | yes | text | | clears, then **real per-character key events** |
| `select` | yes | option value | | falls back to label; `<select>` only |
| `check` / `uncheck` | yes | — | | |
| `scrollTo` | optional | — | `position: top\|bottom` | selector scrolls into view; otherwise position |
| `scrollUntilVisible` | yes | — | `max_scrolls` (default 10) | scrolls the dominant container until the selector is in the viewport |
| `waitFor` | yes | — | `state: visible\|hidden\|attached` | default `visible` |
| `expect` | yes | — | `expect:` | see below |
| `hover` | yes | — | | |
| `goBack` | no | — | | browser back |
| `setViewport` | no | — | `preset: mobile\|tablet\|desktop` | 390x844 / 820x1180 / 1280x900 |
| `swipe` | yes | — | `direction: left\|right\|up\|down`, `distance` px (default 200), `duration` ms (default 300) | touch/mouse drag across the target's centre; needs `hasTouch`/`isMobile` (both on by default). Used for gesture UIs like swipe-to-mark rows |
| `sleep` | no | ms | `reason` **required in v2** | discouraged; validate warns every time |

### Retained from v1

Still first-class, not deprecated.

| action | notes |
|---|---|
| `fill` | clears, then `fill()` — one shot, no key events. Faster than `type`. |
| `press` | keyboard key; selector-scoped if given |
| `scroll` | selector into view, or window by pixels |
| `wait` | wait for selector visible, or a fixed ms |
| `snapshot` | no interaction — capture the current state only |

### Automatic runner behaviours (no manifest fields)

- **Interstitial dismissal.** Before every interactive action (and after every
  navigation) the runner clears any known interstitial that intercepts taps —
  the `interstitials` selectors in the app profile (`src/interstitials.ts`).
  Most apps need none. It is the *only* place text/aria-label matching is
  allowed, and the day an app grows a nudge the fix is one selector there. To capture an
  interstitial *before* it is dismissed, put a `snapshot` step (non-interactive,
  so it is not pre-dismissed) with a `settle_ms` long enough for it to appear.
- **Stability gate (never capture a loading state).** Before every screenshot the
  runner waits for network quiet, the absence of spinners/skeletons/progressbars,
  and a DOM that stops changing across two polls (min 300 ms since the action).
  If it never settles, the shot is still taken but named `{id}.loading.png` and
  flagged unstable — see `src/stability.ts`.

**`type` vs `fill`.** `fill()` sets the value in one shot. Some controlled
inputs key their internal state off `keydown` rather than the DOM value, so
`fill` can look correct on screen without actually arming the submit button —
grouped-digit phone fields and PIN fields that submit on the last digit are the
classic cases (react-native-web apps especially), which is why the login
adapters type key by key there. Prefer `type` for new work;
`fill` is there when speed matters and the input is known to be simple.

### `expect`

```yaml
- id: 040-expect-error
  action: expect
  selector: '[data-testid="field-error-name"]'
  expect: visible          # visible | hidden | enabled | disabled
```

```yaml
  expect:
    text: "Changes saved"
```

```yaml
  expect:
    count: { min: 1, max: 5 }
```

---

## Screenshot modes

| mode | writes | notes |
|---|---|---|
| `viewport` | `<id>.viewport.png` | what the user actually sees |
| `full` | `<id>.viewport.png` **and** `<id>.full.png` | both, deliberately |
| `element:<selector>` | `<id>.element.png` | one element, expanded if it scrolls |
| `auto` | `<id>.viewport.png`, or nothing | see the capture rule below |
| `false` | nothing | |

v1 mapping: `screenshot: true` is `viewport`; `screenshot: true` +
`full_page: true` is `full`.

`setup` and `teardown` default to no capture — they are plumbing, not
documentation — but an explicit mode there is still honoured.

**`full` and scrollable dialogs.** Playwright's `fullPage: true` captures the
*page* scroll, and the page behind a modal is usually scroll-locked, so a naive
full-page shot misses exactly the content you wanted. `full` therefore looks for
a visible overlay whose content overflows and captures that instead: it expands
the scroll container to its natural height and takes one element shot. If the
layout refuses to expand (sticky or absolutely positioned children), it falls
back to slicing the container at successive scroll offsets and compositing them
on an offscreen canvas. Either way you get one continuous image.

### `screenshot: auto`

Captures only when the step produced a **visible state change**. The visual
state is read before the action and again after settle; a PNG is written if any
of these nine signals differ:

route change · modal/sheet/dropdown open or close · scroll revealing
previously off-viewport content · list content change · validation error
appearing · toast or banner appearing · tab change · loading to loaded ·
disabled to enabled

A step that changes nothing visible writes no file and logs why:

```
⊘ [settings/team] 040-search (type) — screenshot: auto,
  no visible state change (route=same overlays=same scroll=same lists=same
  errors=same toasts=same tab=same loading=same disabled=same)
```

Error and toast text is scrubbed through the same volatile-pattern normaliser
the fingerprint layer uses, so a toast containing a timestamp does not fire its
signal on every run.

**Known limitation:** `auto` does not watch the DOM skeleton hash. A step whose
only effect is text changing in place — a field value, a counter — will not
capture. Declare `viewport` explicitly for those.

---

## Settle

Unconditional before every capture and before both reads of the visual state:

```
network idle -> two animation frames -> settle_ms
```

`settle_ms` resolves as step override, then flow `settle_ms`, then **350**.

The two animation frames matter. `networkidle` only says the fetches finished,
not that the resulting render has been painted. Capturing one frame early
catches a half-drawn transition, and a half-drawn transition hashes differently
every run — which poisons the fingerprint baseline with permanent false
"changed" verdicts.

---

## Output naming

```
runs/{app-id}/{run-id}/{Device}/{module}/{flow}/{step-id}.{mode}.png
```

Zero-padded, sortable, and the same names in every run, so two runs compare
file for file. Modes: `viewport`, `full`, `element`, `failed`, `loading`. Each
run writes into its own folder, so a fixed step never inherits a stale
`.failed.png`.

---

## Assertions

All optional, all combinable on one step:

`text_contains`, `text_not_contains`, `selector_visible`, `selector_hidden`,
`url_contains`, `count: { selector, min, max }`.

A failed assertion fails the **step**. A failed non-`optional` step fails the
**flow** and aborts its remaining steps — the partial `flow-run.json` is still
written, so you can see exactly where it broke.

Every failure names the flow, the step id and the selector:

```
✗ [settings/edit-profile] step 070-open-timezone (click)
    selector=[data-testid="profile-timezone-field"]:
    locator.waitFor: Timeout 15000ms exceeded waiting for state "visible"
```

---

## setup / teardown

Both take the same step vocabulary.

- `setup` runs first. Use it to establish the flow's own starting point.
- `teardown` **always** runs, including after a failed step. Its failures are
  recorded in the run manifest but never change the flow's status: the captures
  already happened, and losing them to a cleanup hiccup helps nobody. In a
  dummy write flow it is required, and deletes what the flow tagged.

**Flows must be independently runnable.** No flow may depend on navigation
state or data left behind by another.
This is enforced, not just documented: `npm run validate` rejects any `{{VAR}}`
that is not an env var, not a key in the flow's own `vars`, and not `RUN_ID` /
`RUN_TAG`.

---

## Interpolation

`{{APP_URL}}`; the `userEnv` / `secretEnv` variable of every account in the
profile (e.g. `{{ADMIN_EMAIL}}`, `{{ADMIN_PASSWORD}}`); the profile's
`extraEnvVars` (e.g. a pinned record id); plus anything under the flow's own
`vars:`. Two dynamic values are injected per run: `{{RUN_ID}}` and
`{{RUN_TAG}}` (= `SCRSHOT_<run_id>_`). Only a dummy write flow ever types
`{{RUN_TAG}}` into the app — it is how its records are found again.

**Credentials are redacted before anything is written.** Every selector, input
and result string that lands in a run manifest or the log passes through
`redactSecrets()` (`src/env.ts`), which replaces every account secret with
`«redacted»` and every login (a mobile number in any spacing or prefix, or an
email / username, case-insensitively) with `«redacted:<ENV_NAME>»`. Log lines
pass through the same function. That is why a sign-in flow types a PIN as ONE
value from `{{…_PIN}}` rather than tapping keypad keys: one value can be
redacted, single-digit selectors cannot.

---

## Selector policy

**Enforced by `npm run validate` as a hard error**, on `selector`, on every
`mask` entry, on `assert.selector_visible` / `assert.selector_hidden` /
`assert.count.selector`, and on `screenshot: element:<selector>`.

Allowed — and nothing else:

```yaml
'[data-testid="btn-submit"]'                            # =, ^=, *=, $= all fine
'[data-testid="user-row-{{FIXED_USER_ID}}"]'            # {{VAR}} inside the value
'[data-testid^="order-card-"]'                          # prefix — "the first order card"
'role=button[name="Change password"]'                   # Playwright role engine
'role=button[name=/^Notifications/]'                    # role + regex name, for names that carry a count
'[data-testid="row-1"] [data-testid="btn-edit"]'        # a chain, if every term is on policy
```

In a react-native-web app a component's `testID` reaches the DOM as
`data-testid`, and `accessibilityRole` + `accessibilityLabel` reach it as
`role` + `aria-label`, so both allowed forms map straight onto the app source.
Named controls without a test id are what role selectors are for — not an
exemption.

Rejected, with the offending flow, step and selector named:

```yaml
'.card .title'            # CSS class chain — utility classes churn on every restyle
'ul li:nth-child(3)'      # positional — breaks the moment a row is inserted
'text=Save'               # text-matching — use role=<role>[name="..."]
'#submit'                 # not on the allowlist
'input[name="mobile"]'    # not on the allowlist
```

This is an allowlist, not a denylist, so a flaky form cannot creep back in under
a shape the denylist didn't anticipate.

The literal `TODO_SELECTOR` (from the recorder's converter) is reported by its
own raw-text gate rather than the policy, so one problem produces one error.

Where a control genuinely has no test id and no usable role/name pair, the
escape hatch is per-step and requires a reason:

```yaml
- id: 050-open-legacy-picker
  action: click
  selector: '#datepicker-trigger'
  selector_exempt: 'no test id on the legacy date picker — app PR #214 pending'
```

Validate then reports it as a warning on **every** run, so an exemption can
never quietly become permanent. The right fix is a test id in the app repo;
`docs/SELECTOR-GAPS.md` describes how to keep that backlog per app.

---

## What a step proves (coverage)

`npm run coverage` counts an interactive element as covered only when a step
**exercises** it: `click`, `tap`, `type`, `fill`, `select`, `check`, `uncheck`,
`press` or `swipe`, on the last term of the step's `selector`. Every other
mention **locates** it without covering it: `waitFor`, `expect`, `hover`,
`scrollTo`, `scrollUntilVisible`, `wait`, `snapshot`, any `assert.*`, `mask`,
`screenshot: element:…`, and the ancestor terms of a descendant chain
(`[data-testid="sheet"] [data-testid="sheet-save"]` exercises `sheet-save`
and only locates `sheet`). An id written in `description`, a comment or
`depends_on_routes` is not a usage. Drafts and `disabled: true` flows never count.

A page is visited by a `goto`, or by an `assert.url_contains` that names a path
(`/orders/` + id). `depends_on_routes` is reported as *declared*, never as a visit.

Prefer an exact `[data-testid="…"]` on the step that does the thing. A `^=`
prefix covers the one dynamic family it names (`[data-testid^="course-card-"]`
covers `course-card-*`); a prefix that matches several separate ids covers none
of them. `role=` selectors are resolved by run evidence (`--evidence`), which
records the test id each step actually pressed. Reference: `docs/COVERAGE.md`.

## Recording flows instead of writing them

Authoring hundreds of steps by hand is the bottleneck, so a scenario can be
walked once in a real browser and converted into a draft:

```bash
npm run record -- --app my-app --flow settings.edit-profile       # headed; you drive, it observes
npm run record:convert -- --app my-app --flow settings.edit-profile
npm run record:diff -- --app my-app --flow settings.edit-profile  # read-only: what would change
```

`record` authenticates via `src/login.ts` FIRST and installs its listeners
after, so nothing the login does appears in the log. It never synthesises an
interaction. It signs in as the profile's `defaultAccount` (`--as <identity>`
for another). It writes `apps/<app-id>/recordings/<flow>.json` (values matching
passwords, tel/email inputs, email shapes, 10-digit numbers and every account's
login and secret are redacted at record time) and refuses to overwrite an
existing recording without `--force`.

`record:convert` is deterministic — no LLM anywhere in the path. It maps the
log to schema v2: testid selectors first, role/name only when verified unique
at record time, `TODO_SELECTOR` otherwise; consecutive scrolls collapse into
one `scrollUntilVisible` targeting whatever was clicked next; a click that
opened a dialog captures `element:<dialog>` and is followed by an
`expect ... visible`; route changes become `assert.url_contains` on the causing
step. It writes `apps/<app-id>/flows/<flow>.generated.yaml` and never touches
`<flow>.yaml`.

**Drafts cannot run.** `*.generated.yaml` is excluded from `loadFlows()`, so
the runner, doc-generator and discovery never see it. `npm run
validate` reports each draft as `draft — N TODO(s) remaining, not executable`
without failing.

**Promotion is manual**: resolve every `TODO_SELECTOR`, answer `run_tag` on
each `type` step (if the honest answer is `true`, the flow can only be promoted
as a dummy write flow), replace the `TODO` teardown with steps that return the
app to where the flow started, delete the `# GENERATED — review before use`
header, and rename the file to `<flow>.yaml`. A promoted flow still containing any of those markers is a
hard validation error — checked against the raw file text before YAML parsing,
so the first error you see is the TODO itself.

---

## Dummy write flows

Pages that exist only after a write — confirmations, "record created" states,
registration steps — are captured with the **dummy account**, in its own
separate test tenant. A flow may write only when **all** of these hold:

1. `WRITE_MODE=dummy` (in `apps/<app-id>/.env` or the shell);
2. the flow declares `writes: true` **and** `auth: dummy`;
3. after sign-in, the tenant id **and** name the app shows equal the profile's
   `dummyAccount.fingerprint` **exactly**;
4. the host is in the profile's `writeAllowedHosts`.

With `WRITE_MODE` off, write flows are skipped with a reason. With it on, any
failed gate aborts the whole run before the first action; the dummy tenant is
verified before any flow runs.

What validate requires of a write flow:

| rule | why |
|---|---|
| `auth: dummy` and `writes: true` | real logins are permanently read-only |
| at least one `run_tag: true` step, and every such value contains `{{RUN_TAG}}` | every record the run creates carries the run id |
| a non-empty `teardown` | it deletes what the run tagged |
| emails typed or in `vars` on a reserved domain (`@example.com`, `*.example`, `*.test`) | mail can never reach a person |
| phone numbers obviously fake: `555-01xx`, a run of one digit, or listed in `dummyAccount.syntheticPhones` | SMS can never reach a person |

At run time the executor refuses any write step that did not pass the gates,
and a teardown step that taps, types or clicks runs **only while the run tag is
on screen** — so a teardown can delete this run's records, never the tenant's
seed data.

A write flow that triggers outbound messages declares them:

```yaml
sends_messages: [email, whatsapp]
```

It is skipped, and listed under `flagged` in `run-summary.json`, unless the
profile says the dummy tenant's messaging is off
(`dummyAccount.messagingSuppressed: true`).

Write flows change list contents, so their screenshots differ run to run; use
`mask:` on the volatile rows and keep write flows in their own modules so they
cannot destabilise the read-only baselines.
