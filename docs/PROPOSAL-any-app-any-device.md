# Proposal — capture every page of an app you own, on the device types you choose

Status: **proposal only. No code has been changed.** This exists to be reviewed
and decided on first.

Revision 3 — two decisions now recorded (§7): a **dummy account with free
navigation** will be provided, which unlocks the write-only pages and adds Phase C;
and device resolutions are **common defaults, chosen here** rather than specified.

Revision 2 — rewritten after the clarification that (a) the target is an app
**you own and whose repo you share**, not arbitrary public apps, and (b) the tool
should **ask which device types to capture**, and write each device to its own
top-level folder.

Written for the project owner and whoever will implement the change.

---

## 1. The two questions, answered

### 1.1 "I own the app and share the repo. Will this capture screenshots of all its pages?"

**Today: not reliably, and it cannot prove it did.** The capture engine is fine.
What is missing is a *provable link between the app's real page list and what the
tool visits*.

Concrete evidence from the app in front of us:

| | Count | Source |
|---|---|---|
| Route files in the app repo (`app/**`, expo-router) | **31** | `C:\Business\Rosifit\app` |
| Routes listed in `config/known_routes.json` | **20** | hand-derived once, dated 2026-09-12 |
| Routes never listed | at least 10 | `/register`, `/change-mobile`, `/holiday`, `/course/edit`, `/member/edit`, `/member/import`, `/offering/edit`, `/send/result`, `/staff/pin`, `/set-pin` |

The route inventory is a **hand-maintained JSON file that drifts from the repo the
moment someone adds a page**. `npm run discover` only finds pages reachable by
tapping the live navigation, so a page with no nav entry stays invisible. Nothing
in the pipeline ever compares "pages that exist in the repo" against "pages we
captured", so a missing page is silent.

The other blockers for onboarding *your* app:

- **Sign-in is hard-coded** to RosiFit's mobile + 4-digit PIN screen, with fixed
  selectors ([login.ts:32-39](../src/login.ts#L32-L39)). Your app's login will not match.
- **App identity is hard-coded** — locale `en-IN`, timezone `Asia/Kolkata`,
  interstitial selectors, discovery selectors, doc prose, and the PII pattern for
  personal data (an Indian mobile number).
- **Selector policy needs `data-testid`.** That is an advantage when you own the
  repo — you can add them — but it needs a gap report you can act on.

**With Phase B below: yes, with a coverage number you can audit** — and with
Phase C (dummy account) the write-only pages come within reach too. The limits
that remain are in §5.

### 1.2 "Ask me which device types to capture."

Today it never asks, and could not honour the answer: every run emulates a Pixel 7
(`isMobile: true`, `hasTouch: true` are unconditional in
[browser.ts:17-30](../src/browser.ts#L17-L30)), there is no `--device` flag, and
no output path carries a device, so a second device would overwrite the first and
corrupt the change-detection baseline. Phase A fixes exactly this, in the folder
shape you asked for.

---

## 2. Phase A — device types, chosen by you (do this first)

### 2.1 The tool asks

`npm run capture` with no device given prompts:

```
Which device types should this run capture?  (space to toggle, enter to confirm)

  [x] Mobile    390 x 844   @2x   iPhone 14 / Pixel 7 class, touch
  [ ] Tablet    820 x 1180  @2x   iPad Air, touch
  [ ] Laptop   1440 x 900   @2x   desktop browser, no touch

> Mobile, Laptop
```

Any combination is valid — one, two or all three. Non-interactive use is
unchanged in spirit:

```bash
npm run capture -- --device Mobile --device Laptop
npm run capture -- --all-devices
DEVICES=Mobile,Tablet npm run capture          # CI
```

With no TTY and no flag, the run uses `default` from config and says so loudly in
the log, so existing scheduled jobs keep working. *(Decision 6 in §7: is that the
behaviour you want, or should it refuse to guess?)*

### 2.2 The folder layout you asked for

Device becomes the **main folder**, modules underneath, screenshots below that:

```
screenshots/
  Laptop/
    attendance/
      courses-workspace/
        010-overview.viewport.png
        020-attendance-tab.full.png
      course-detail/
        020-open-course.viewport.png
    members/
      member-directory/…
  Mobile/
    attendance/…
  Tablet/
    attendance/…
```

The same device-first split runs through every output, so nothing collides:

| Output | New path |
|---|---|
| Screenshots | `screenshots/{Device}/{module}/{flow}/{step}.{mode}.png` |
| Run manifests | `runs/{YYYY-MM-DD}/{Device}/{module}-{flow}.flow-run.json` |
| Fingerprint baseline | key `{Device}/{module}/{flow}/{step}` — one baseline per device, so a tablet run is never compared against a phone |
| Evidence run | `evidence/{run_id}/{Device}/{module}/{flow}/…` |
| Evidence index (C2) | frame id `{Device}/{module}/{flow}/{step}#kind`; coverage reported per device |
| Generated docs | `docs/{Device}/{module}.md` |

### 2.3 Device profiles — `config/devices.json`

```json
{
  "devices": [
    { "id": "Mobile", "viewport": { "width": 390,  "height": 844  }, "dpr": 2,
      "emulate": "Pixel 7",      "isMobile": true,  "hasTouch": true },
    { "id": "Tablet", "viewport": { "width": 820,  "height": 1180 }, "dpr": 2,
      "emulate": "iPad (gen 7)", "isMobile": true,  "hasTouch": true },
    { "id": "Laptop", "viewport": { "width": 1440, "height": 900  }, "dpr": 2,
      "emulate": null,           "isMobile": false, "hasTouch": false }
  ],
  "default": ["Mobile"]
}
```

**Why these three** (decision 2 answered: "any commonly used resolutions"):

| Device | Viewport | Stands for | Note |
|---|---|---|---|
| Mobile | 390 x 844 @2x | iPhone 14 / Pixel 7 class | today's only profile — unchanged, so existing output stays comparable |
| Tablet | 820 x 1180 @2x | iPad Air 10.9" portrait | the common tablet breakpoint |
| Laptop | 1440 x 900 @2x | MacBook Air / 16:10 laptop | the most common *laptop browser viewport* |

These are **browser viewports, not screen resolutions** — a 1920x1080 monitor shows
roughly a 1920x950 viewport once browser chrome is subtracted, and most CSS
breakpoints stop mattering above ~1440. Adding `Desktop` at 1920x1080 @1x later is
one entry in this file and needs no code change. Landscape tablet or a narrow
`Mobile-Small` (360x640) are equally cheap to add.

A **truthful** Laptop capture needs `isMobile: false`, `hasTouch: false` and a
desktop user agent — not merely a wider window. That is the substance of this
phase; the folder layout is the visible part.

### 2.4 Work involved

1. `newContext(browser, storageState, device)` builds UA, `isMobile`, `hasTouch`
   and `deviceScaleFactor` from the profile (`src/browser.ts`).
2. Device prompt + `--device` / `--all-devices` / `DEVICES` (`src/runner.ts`);
   the runner loops flows per selected device.
3. Device inserted into every path and key listed in §2.2.
4. C1 gate: expected DPR read **per frame from its device profile** instead of one
   global `DEVICE_SCALE_FACTOR` ([evidence-check.ts:131](../src/manual/evidence-check.ts#L131)).
5. C2 index: `device` field on every frame, in the screen catalog key and in
   coverage; canonical selection runs per device.
6. Flow manifests gain optional `devices: [Mobile, Laptop]` for a flow that only
   makes sense on one form factor; the others are skipped with a recorded reason.
7. Optional follow-on: a per-step `responsive_diff` note when the same step yields
   materially different layouts across devices.

**Migration:** existing output is keyed without a device. Recommend a one-off move
of the current tree under `Mobile/`, then one `--update-baseline` run. **Both
evidence gates must be re-run and re-signed**, because frame ids and the DPR check
change.

**Effort:** 3–4 days. **Risk:** medium — touches paths, baseline and both gates.

---

## 3. Phase B — onboard an app you own, and prove page coverage

The point of sharing the repo is that the repo is the **source of truth for the
page list**. Four additions turn that into a guarantee.

### 3.1 Route inventory generated from the repo

```bash
npm run routes:scan        # reads APP_REPO_PATH, rewrites config/known_routes.json
```

A small adapter per framework turns route files into route patterns:

| Framework | Rule |
|---|---|
| expo-router / Next.js app dir | `app/**/page.tsx` or `app/**/*.tsx` → path; `(group)` stripped; `[id]` kept as `[id]` |
| Next.js pages dir | `pages/**/*.tsx` → path; `_app`/`_document` ignored |
| React Router (declarative) | parse the route config module, or declare routes in config |

Output keeps today's shape (`path`, `label`, `module`) and adds
`source_file`, `dynamic: true|false` and `first_seen`. Unknown-framework projects
fall back to listing routes by hand — same file, no new concept.

Applied to RosiFit today this would immediately surface the ~10 pages the
inventory has never mentioned.

### 3.2 A page-coverage report — the actual answer to "all pages?"

```bash
npm run coverage:pages
```

Writes `docs/PAGE-COVERAGE.md` and exits non-zero when a page is uncovered and
not explicitly excused:

```
Pages in repo: 31   covered by a flow: 24   captured in the last run: 24   uncovered: 7

UNCOVERED
  /member/import   members   no flow           → scaffold one
  /register        signin    excluded: write   → reason recorded in config
  /send/result     send      needs a send      → unreachable read-only
```

"Covered" means a flow declares the route **and** a captured frame was observed on
it in the last run — the C2 evidence index already records the route pattern of
every frame, so this is a join, not new instrumentation.

### 3.3 Flow scaffolding for uncovered pages

```bash
npm run flows:scaffold -- --route /member/import
```

Generates a draft manifest into `flows/_drafts/` (goto → settle → screenshot →
assert something visible) for you to review and promote. Dynamic routes get a
`{{FIXED_*}}` placeholder so you pin the record.

### 3.4 App profile, so nothing about your app is hard-coded

`config/app.json`: app id and display name, allowed hosts, locale, timezone,
colour scheme, interstitial selectors, discovery selectors, doc-prose vocabulary,
and the auth adapter:

- **`storage-state` (recommended default for any new app)** — a human signs in once
  by hand, the session is saved to `.auth/<app>-<identity>.json`, runs reuse it.
  No app-specific selectors; works with SSO, OTP and MFA.
- `form` — selectors plus secret env names, declared in config (email/password).
- `mobile-pin` — today's RosiFit behaviour, kept as one adapter.
- `none` — signed-out capture.

Per-role identities (`admin`, `staff`, …) so role-gated pages are reachable.

**PII rules become per-app data** in `config/pii-regions.json`: which phone shapes
count as personal, which identifier variables exist, which values are secrets. The
classifier's rule *order* (architecture §8.2) does not change — this is data, not
new logic.

### 3.5 A `testID` gap report you can act on

Since you own the repo, the fix for an unreachable control is to add a `testID`.
`npm run selectors:audit` compares flow selectors against the testIDs present in
the app source and regenerates `docs/SELECTOR-GAPS.md` (today hand-written), so
the list of "testIDs the app still needs" is always current.

**Effort:** 4–6 days. **Risk:** medium — the auth adapter is the delicate part.

---

## 4. Phase C — dummy-account capture, for the write-only pages

Decision 1 answered: **a dummy account with free navigation will be provided.**
That unlocks the pages no read-only run can reach — `/register`, `/set-pin`,
`/member/import`, `/send/result`, save confirmations, success toasts, "record
created" states — and it is the difference between ~75% and ~100% page coverage.

It also **breaks the project's load-bearing invariant**, so it needs building
deliberately. Today a write is a hard validation error
([flow-loader.ts:360](../src/flow-loader.ts#L360)) and a `cleanup:` block is
rejected outright (:368) on the grounds that nothing may be written. Phase C
re-opens that door for one account only.

### 4.1 First, a question I need answered (§7, decision 3)

**Is the dummy account a separate tenant/academy, or another user inside the real
academy?**

- **Separate tenant (strongly preferred).** Its writes are invisible to real users.
  Everything below is safe.
- **A user inside the real academy.** Then a dummy course or member created by a
  capture run is **visible to real staff, counts in real reports, and may trigger
  real follow-up emails**. I would not enable writes in that arrangement — the
  blast radius is the customer's live data.

### 4.2 Interlocks — writes must be impossible by accident

A flow may write only when **all** of these hold; any one missing is a hard error:

1. `WRITE_MODE=dummy` in `.env` (default `off`).
2. The flow declares `writes: true` **and** `auth: dummy`.
3. The signed-in identity is the dummy one — verified **after** sign-in against
   `DUMMY_ACCOUNT_FINGERPRINT` (tenant/account id read from the app), not merely
   from which credential variable was used. A typo that signs in as the real admin
   aborts the run before any action.
4. The host is in `WRITE_ALLOWED_HOSTS` (a separate, usually narrower allowlist).

The admin and staff identities stay **permanently read-only** — the existing
validation applies unchanged to every flow that is not `auth: dummy`. Write mode
is recorded in the run manifest, the evidence run and the log banner, so no
artifact is ambiguous about how it was produced.

### 4.3 Data hygiene

- **Every created record carries a run tag** — `run_tag: true` regains its original
  meaning: the value gets a run-scoped marker (e.g. `CAPTURE-2026-09-25T10-00Z`),
  so anything a run created is identifiable and removable afterwards.
- **`teardown:` comes back for write flows only**, and a `writes: true` flow must
  declare either a teardown that deletes what it made, or
  `accumulates: true` with a reason (accepting junk on a disposable account).
- **Screenshot churn**: created records change list contents, so a write flow's
  screenshots would otherwise differ every run and report permanent "changed".
  Mitigations already in the schema: `mask:` the volatile rows, and keep write
  flows in their own modules so they cannot destabilise read-only baselines.

### 4.4 The payoff beyond coverage: publishable screenshots

A dummy account holds **synthetic** members, courses and emails. Today 54 of 76
frames in the last evidence run are flagged `redaction-required` because real
personal data is on screen. Captured against a dummy tenant, that data is
invented, so — with a per-app config switch that is valid **only** when the run
is authenticated as the dummy identity — those regions can classify as safe
instead of personal, and the C1/C2 pipeline can emit screenshots that need **no
redaction before publication**.

That is the strongest argument for doing Phase C: it is not only about reaching
more pages, it is what makes the output directly usable in a customer-facing
manual.

The classification rule *order* (architecture §8.2) does not change. What changes
is which regions are declared synthetic, in config, for one account.

**Effort:** 3–4 days. **Risk:** high — it relaxes the project's central safety
rule. Mitigated by the interlocks in §4.2, and every one of them gets a unit test.

---

## 5. Limits that remain — decide how to handle each

These are why "all pages" needs your policy, not just code:

1. **Pages that only exist after a write** — now addressed by Phase C
   (dummy account). Still a limit until that phase ships, and still a limit for
   any app where no dummy account exists.
2. **Role-gated pages** need credentials per role, or they stay uncovered.
3. **Dynamic routes** (`/course/[id]`) need a pinned record id, or the capture
   drifts as data changes.
4. **States are not pages.** Modals, dropdowns, empty states and error states are
   not routes; they need flow steps. Page coverage counts routes; a second metric
   (distinct `expect_screen` names) counts states, and only you can say which
   states matter.

---

## 6. Suggested sequence

| | Phase | Delivers | Effort |
|---|---|---|---|
| 1 | **A — device types** | You are asked which devices; `Laptop/`, `Mobile/`, `Tablet/` top-level folders; truthful emulation per device | 3–4 days |
| 2 | **B1 — route inventory + coverage report** | A provable "N of M pages captured" for any app whose repo you share | 2–3 days |
| 2b | **C — dummy-account write mode** | The write-only pages, and screenshots that need no redaction | 3–4 days |
| 3 | **B2 — app profile + auth adapters** | A second app onboarded without touching engine code | 3–4 days |
| 4 | **B3 — scaffolding + selector audit** | Uncovered pages become draft flows; testID gaps stay current | 1–2 days |

Phase A stands alone and is the one you asked for most directly. B1 is the
smallest step that answers "will it capture all pages?" with a number.

Nothing loosens: the read-only rule, the safety-gate allowlist, the C1
classification order and privacy schema, and both gate criteria all stay as they
are — they gain a device dimension, nothing more. Every phase ships with unit
tests and merges only with `npm test`, `npm run typecheck` and both evidence gates
passing.

---

## 7. Decisions

**Answered**

1. ~~Staging vs live for write-only pages~~ → **a dummy account with free
   navigation will be provided.** Becomes Phase C above.
2. ~~Device names and resolutions~~ → **common defaults chosen here**: Mobile
   390x844, Tablet 820x1180, Laptop 1440x900, all @2x. Easy to add to later.

**Still open**

3. **Dummy account isolation** — separate tenant/academy, or a user inside the
   real academy? *(§4.1 — this gates whether Phase C is safe to build at all.)*
4. **One repo per app (fork), or one repo capturing several apps** via
   `apps/<app-id>/…`? Phase B works either way.
5. **Which sign-in schemes** must be supported beyond hand-seeded sessions?
6. **No-TTY default** — use `default` from config with a warning, or refuse to run
   without an explicit `--device`?
7. **Migration** — move existing output under `Mobile/`, or re-capture from scratch?

**Suggested first slice:** Phase A alone (device types + folders). It is
self-contained, needs no further decisions, and is the part you asked for most
directly.
