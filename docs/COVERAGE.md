# Coverage and page detection

Two static checks that answer one question for every registered app: **does each
interactive element and each page have a screenshot flow, or a written reason
why not?** A new button or a new page in any app either gets a flow, or gets an
approved exception, or fails the check — nobody has to remember a checklist.

```bash
npm run coverage -- --app jalsa                 # one app, full report
npm run audit:coverage -- --app all             # every registered app, in order, with a summary
npm run audit:coverage -- --app rosifit --evidence   # coverage from recorded runs, not manifests
```

Both run offline: no browser, no credentials, no network. They read the app's
source (a local clone, read-only) and this repository's flows and inventories.

---

## 1. What each check detects

### Test-id coverage (`coverage`, audit step 3)

The app's source is parsed with the TypeScript compiler's own parser (TS, TSX,
JS, JSX). For every JSX element carrying a test-id attribute
(`source.testIdAttributes`, default `data-testid` and `testID`) it records the
id, its file and line, and whether the element is **interactive**:

| interactive because | examples |
|---|---|
| of what it is | `button`, `a`, `input`, `select`, `textarea`, `Pressable`, `TouchableOpacity`, `TextInput`, `Switch`, `Button`, `Link` (+ `source.interactive.elements`) |
| of a handler it carries | `onClick`, `onPress`, `onChange`, `onChangeText`, `onValueChange`, `onSubmit`, `onCheckedChange`, `onSelect`, `onToggle`, `onConfirm`, `onCancel`, `href` (+ `source.interactive.handlerProps`) |
| of its ARIA role | `role` / `accessibilityRole` of `button`, `link`, `checkbox`, `tab`, `switch`, `textbox`, … |
| it forwards its id to one of the above | `function Row({ testID }) { return <Pressable testID={testID} onPress…/> }` makes every `<Row testID="x">` interactive |

Ids built at run time are inventoried as **families**: `` `course-card-${id}` ``
is `course-card-*`, `on ? 'a' : 'b'` is both `a` and `b`. Ids handed to inner
controls are read too: `testIDPrefix="member-tab"` registers `member-tab*`,
`confirmTestID="x"` registers the confirm button `x`, a same-file helper
`action('header-add', …)` registers `header-add`, and
`{ testID: 'x', onPress }` registers `x`.

Then every executable flow step is read (drafts and `disabled: true` flows are
not executable). A test id counts as **covered only when a step exercises it**:

| exercising (covers) | locating (never covers) |
|---|---|
| `click`, `tap`, `type`, `fill`, `select`, `check`, `uncheck`, `press`, `swipe` — on the **last** term of the selector | `waitFor`, `expect`, `hover`, `scrollTo`, `scrollUntilVisible`, `wait`, `snapshot`, every `assert.*`, `mask`, `screenshot: element:…`, and any ancestor term of a descendant chain |

A test id written in a description, a comment or `depends_on_routes` is not a
usage at all. A prefix selector (`[data-testid^="menu-item-"]`) covers the one
family it names; one that matches several literal ids is **ambiguous** and
covers none of them. `role=` selectors cannot be mapped to a test id from the
manifest alone — run evidence resolves them (§6).

Reported for each app, grouped by module (`routes.map.json` source paths):

- **NEW uncovered** — interactive, not exercised, not excepted, not on the backlog → **blocking**
- **Existing uncovered** — on the adoption backlog (§4): debt, listed every run
- **Excepted** — an approved exception (§4), with its reason
- **Covered** — with the `flow#step` that exercised it; *conditional* when only optional steps did
- **Stale references** — a flow selector naming an id that exists nowhere in the source → **blocking**
- **Ambiguous selectors**, **possible duplicates** (one id at several places — platform variants such as `x.tsx`/`x.ios.tsx` are not duplicates), **unresolved** forwarded props, **shadowed** ids (`<Button asChild>` whose child's id wins), **derived** families (`${testId}-confirm`, owed by the call site)
- **Parse errors** — a file the parser could not fully read → **blocking**

### Page inventory (`coverage`, audit step 4)

Pages are discovered from the router's file conventions, the way the router
reads them — so a page is found even when nothing links to it.

| `source.routes.strategy` | what is a page |
|---|---|
| `nextjs-app` | `page.{tsx,ts,jsx,js,mdx}` under `appDir`. `(group)` folders vanish; `[x]` dynamic, `[...x]` catch-all, `[[...x]]` optional catch-all; `_private` folders, `route.ts` APIs and layouts are not pages; `(.)x` intercepting routes and `@slot` parallel routes are **unclassifiable**; a page that only calls `redirect()` and `redirects()` in `nextConfig` are **redirects** |
| `expo-router` | every module under `appDir` with a default export that renders JSX. `index` is its folder; `(group)` vanishes; `.ios/.android/.native/.web` variants are one route; `_layout`, `+html`, `+native-intent`, `+middleware`, `+not-found` and `name+api` are not screens; a module that renders nothing (a client or helper kept in the router folder) is not a page; a screen that renders only `<Redirect>` is a redirect |
| `none` | the app declares it has no file-based router. The page step reports *not applicable* — said, not assumed |

Compared with `apps/<id>/config/known_routes.json` (parameter names do not
matter: `/orders/[orderId]` is `/orders/[id]`):

- **NEW unregistered** — a page in the source missing from the inventory → **blocking**
- **Removed** — an inventory entry whose page is gone → **blocking** (mark a non-file route `"kind": "virtual"` to keep it without verification)
- **NEW uncovered** — no flow visits the page (a `goto`, or an `assert.url_contains` naming the path; run evidence adds every path a run landed on) → **blocking**. `depends_on_routes` alone is reported as *declared, never visited*
- **Stale navigation** — a `goto` to a path that matches no page → **blocking**
- **Duplicates** (two files claiming one URL), **unclassifiable** routes, **redirects** (listed, not required) and the files that are **not pages**, with the reason

## 2. What the checks cannot detect

Stated so nobody reads more into a green run than it says:

- **An element with no test id.** The check inventories test ids. Untagged
  controls are invisible to it — each app's own test-id gate (e.g. a
  `testid` audit in its repo) is what makes them exist.
- **Interactivity it cannot see.** An element is interactive by its tag, its
  handlers, its role or a component that forwards its id to one of those. A
  custom component that handles a press internally *without* forwarding its
  test id, under a name not in `source.interactive.elements`, reads as display.
  Add the name to `interactive.elements` for that app.
- **Ids built from data.** `${prefix}-${option.label}` over a constant array is a
  family (`prefix-*`), not each option. A flow pressing one member covers the
  family; nothing proves every member was pressed.
- **That the step really ran.** Static mode trusts the executable manifest
  (optional steps are flagged *conditional*). Run evidence (§6) counts only what
  a recorded run did.
- **Whether a page is reachable.** A file route is a page; whether the app's
  navigation or permissions let anyone reach it is not checked. Middleware
  rewrites are not read.
- **Other frameworks.** File-based routing is read for Next.js App Router and
  Expo Router only — the routers the registered apps use. Others declare
  `strategy: "none"` (the page step then says *not applicable*) until a strategy
  is added to `src/coverage/route-scan.ts`.
- **Visual change.** Coverage and DOM fingerprints are separate checks. A
  changed fingerprint does not prove a new feature was exercised, and a covered
  element can still look wrong.

## 3. Registering an app

A registered app is a folder under `apps/` (copy `apps/_template`). Coverage
needs one extra block in `app.config.json`:

```json
"source": {
  "repository": "your-org/your-app",
  "include": ["src/**/*.tsx", "src/**/*.ts"],
  "exclude": ["src/legacy/**"],
  "testIdAttributes": ["data-testid", "testID"],
  "interactive": { "elements": ["IconButton"], "handlerProps": ["onActivate"] },
  "routes": { "strategy": "nextjs-app", "appDir": "src/app", "nextConfig": "next.config.ts" }
}
```

Every path is relative to the **app repository root** — the same convention as
`routes.map.json`, so one module map serves the capture skip filter and the
coverage report. `exclude` always contains `node_modules`, tests, specs and
`.d.ts`. `routes` is required: `"strategy": "none"` must be written, not implied.

Where the clone is (first that is set wins):

1. `--source <path>` on the command line
2. `APP_REPO_PATH_<APP_ID>` in the shell — e.g. `APP_REPO_PATH_MY_APP` for `my-app` (the CI hook)
3. `APP_REPO_PATH` in `apps/<app-id>/.env`
4. `repoPath` in `app.config.json`

A bare `APP_REPO_PATH` in the **shell** is ignored on purpose: with `--app all`
it would aim every app at one tree. When the folder is a git clone, its
`origin` must be `source.repository`, or the check refuses to read it — an app
can never be audited against another app's source. Symlinks out of the root are
not followed.

Then, once, by hand, for an app that already has code:

```bash
npm run validate -- --app my-app
npm run coverage -- --app my-app --register-routes   # append the pages the source has
#   review known_routes.json: labels, modules
npm run coverage -- --app my-app --init-baseline     # record today's uncovered items as debt
#   commit both as their own reviewed change
npm run audit:coverage -- --app my-app               # PASS — and every NEW element fails from now on
```

Nothing in the engine changes. CI picks the app up from its `source.repository`.

## 4. Exceptions and the backlog

Two separate lists — and neither is ever written by a normal run.

### `apps/<id>/config/coverage-exceptions.json` — approved exceptions

A deliberate decision, written by a person and reviewed in the diff, that one
thing stays out of the flows:

```json
{
  "app": "my-app",
  "exceptions": [
    { "testid": "orders-delete", "reason": "Deletes an order; real accounts are read-only.", "module": "orders", "expires": "2027-03-31" },
    { "pattern": "orders-refund-*", "reason": "Refunds go through the payment provider; no sandbox here.", "approvedBy": "ops lead" },
    { "route": "/offline", "reason": "Shown only with the network off; the capture runs online." }
  ]
}
```

Rules, all enforced:

- `app` must be this app's id — a file copied from another app cannot apply.
- Each entry names exactly **one** `testid`, or one `pattern`, or one `route`.
  A `pattern` must be **the exact family the report prints** (e.g.
  `orders-refund-*`) and start with at least 4 fixed characters. There are no
  free wildcards, so no exception can approve an id nobody has written yet.
- `reason` is plain English, at least 15 characters, not a placeholder
  (`TODO`, `tbd`, `n/a` …). `module` must exist in `routes.map.json`.
  `expires` is an ISO date; after it the exception **fails** until renewed or
  resolved.
- An exception that is **no longer needed** fails: the id was covered, removed,
  or is not interactive. Remove the entry. The list can only shrink.
- Unknown keys, duplicates and malformed JSON fail the config step.

Every report lists every exception with its status (`active`, `expired`,
`no longer needed`); `--verbose` prints their reasons.

### `apps/<id>/config/coverage-baseline.json` — the adoption backlog

What was already uncovered on the day the check was switched on. **Debt, not
approval**: every report lists it by module. It exists because a check that is
red on day one over an old backlog gets switched off on day two.

- `--init-baseline` creates it from what is uncovered today, and **refuses**
  when it already exists — the backlog never grows.
- `--shrink-baseline` removes entries that became covered or disappeared; it
  never adds.
- An entry that is covered, gone, or also an exception **fails** the check
  until `--shrink-baseline` removes it.

A NEW uncovered element therefore has two ways forward: a flow step that
exercises it, or a reasoned exception. There is no third.

## 5. Running

### Mode A — locally

```bash
export APP_REPO_PATH_MY_APP=~/code/my-app          # or APP_REPO_PATH in apps/my-app/.env
npm run coverage -- --app my-app                    # report + reports/my-app/coverage.json
npm run coverage -- --app my-app --verbose          # also list backlog, exceptions, unresolved, non-pages
npm run coverage -- --app my-app --json out.json    # JSON somewhere else
npm run audit:coverage -- --app all                 # every app; reports/audit-summary.{json,md}
```

`REPORTS_DIR` moves `reports/` (gitignored). Exit codes, for scripts and CI:

| exit | verdict | meaning |
|---|---|---|
| 0 | PASS | nothing blocking |
| 1 | FAIL | at least one blocking finding (listed in the report and in `blocking[]` of the JSON) |
| 2 | CONFIG | a profile, inventory, exceptions or backlog file is invalid — the message names the field |
| 3 | BLOCKED | the check could not run: no clone configured, the wrong repository, or a scan that read nothing. **Never a pass.** |

`audit:coverage --app all` exits 2 if any app is misconfigured, else 1 if any
failed, else 3 if any was blocked, else 0.

The audit runs, per app and in order: **config** → **inventory** (source found,
right repository, files parsed) → **test ids** → **pages** → **flows**
(`npm run validate`) → **summary**. It never accepts a baseline, writes an
exception, touches an app repo, deploys, or opens a browser.

### Mode B — GitHub Actions

`.github/workflows/coverage-audit.yml` runs on pull requests and pushes to
`main` that touch `apps/`, `src/`, `config/`, `flows/` or the workflow; nightly
at 02:47 IST (21:17 UTC) to catch changes merged into the **app** repos, which
do not trigger this repository's workflows; and on demand
(`workflow_dispatch`).

- The app list is read from `apps/*/app.config.json` by
  `.github/scripts/coverage-matrix.mjs` — no app is named in the workflow.
  Each app is one matrix job: check out this repo, `npm ci --ignore-scripts`
  (no browser download — the checks are static), check out the app repo
  read-only into `app-src/` (`fetch-depth: 1`, no LFS, credentials not
  persisted), run `audit:coverage` for that app.
- The Markdown summary goes to the job summary; `reports/` is uploaded as the
  `coverage-<app>` artifact (14 days).
- It never commits, accepts baselines or writes to an app repository, and has
  `permissions: contents: read`. Concurrency cancels a superseded run on the
  same ref. Nothing it does triggers another workflow.
- An `engine` job (not nightly) runs `npm run typecheck` and `npm test`.

**Enabling it:** merge the workflow to the default branch; schedules run from
there only. Public app repos need nothing more. For a **private** app repo add
a repository secret `APP_SOURCE_READ_TOKEN`: a fine-grained personal access
token (or a GitHub App token) with **read-only Contents** on exactly the app
repos. That is the one credential this needs: the workflow's own `GITHUB_TOKEN`
can only read this repository. Without it that app's job reports **BLOCKED**
— a warning annotation and a summary row, not a red run — so a missing
prerequisite is audible without training everyone to ignore red.

### Cost

No paid service and no AI call. Locally it costs a few seconds per app (the
scan of ~200 files takes 2–4 s). In Actions each app job is about 1–2 minutes
(mostly `npm ci`); the `engine` job about 3–5. GitHub's free tier includes
2,000 Actions minutes a month for **private** repositories (public ones are
free); the nightly audit of three apps uses roughly 3–6 minutes a day, ~150 a
month, plus the PR runs. Check your organisation's plan and spending limit
before relying on it — Mode A gives the same answer for free on any machine.

## 6. Integration mode — coverage from real runs

Static mode trusts the manifests. To count only what a browser actually did:

```bash
npm run capture -- --app my-app --force --device Mobile   # needs the app's .env and a reachable app
npm run coverage -- --app my-app --evidence               # or: npm run audit:coverage -- --app my-app --evidence
npm run coverage -- --app my-app --evidence --run <run-id>
```

For every exercising step the executor records `target_testid`, the
`data-testid` of the element it really pressed, read from the live DOM just
before the action, and `url_after`, the path it landed on. Record ids are
reduced to their family and route pattern (`member-row-*`, `/course/[id]`), as
evidence mode does, so no record id reaches a manifest. Evidence mode then:

- resolves `role=` and prefix selectors to the element they hit;
- does not count failed steps, or optional steps that were skipped;
- uses each flow's most recent run that did not skip it, across devices — and
  a flow with **no** such run contributes **nothing** (listed as lacking evidence;
  its manifest is not taken on trust).

Capture needs credentials and a reachable app, so it is not part of the static
CI audit. Run it where the app's `.env` lives.

## 7. The workflow after an app change

1. Merge the change into the app.
2. `npm run audit:coverage -- --app <id>` (or read the nightly job summary).
3. Read the blocking findings: NEW uncovered ids and pages, stale references, stale navigation.
4. Draft the missing flows — describe the steps, or `npm run record`, then `record:convert` — and `npm run validate -- --app <id>`.
5. Run them: `npm run capture -- --app <id> --flow <module>/<flow> --headed`.
6. Review the screenshots and the `changed` steps.
7. Accept the visual baseline explicitly, only for intended change: `npm run baseline:accept -- --app <id> --module <m>`.
8. Commit the flows, inventory (`known_routes.json`), any exception (with its reason) and `--shrink-baseline` result together. `audit:coverage` is green again.

Steps 2–3 are static and take seconds, so they run before any browser does.
Coverage and the visual baseline stay separate: accepting a baseline never
changes coverage, and coverage never accepts a baseline.

## 8. Reading a report

```
Coverage — Jalsa (jalsa) — static (from the flow manifests)
  Source      UniqBrio/JalsaRestaurant @ 038edee087 — /work/JalsaRestaurant (verified, from APP_REPO_PATH_JALSA)
  Inventory   196/196 files parsed · 895 test ids · 544 interactive · 263 display · 246 dynamic families · 7 unresolved
  Flows       0 executable
  Test ids    0/544 exercised (0%) · NEW uncovered 1 · backlog 543 · excepted 0

  owner: 1 NEW uncovered test id
    ✗ owner-bill-split — jalsa/src/features/owner/BillDetailSheet.tsx:127 <button>

  Pages       7 pages (+0 redirects) via nextjs-app · 0 visited · NEW unregistered 1 · removed 0 · NEW uncovered 1 · backlog 6
    ✗ NEW page not in known_routes.json: /owner/reconcile — jalsa/src/app/owner/reconcile/page.tsx
    ✗ NEW page no flow visits: /owner/reconcile — jalsa/src/app/owner/reconcile/page.tsx

  VERDICT FAIL — 3 blocking findings
```

*(A "Split bill" button and a reconcile page added to a copy of the Jalsa
source, against the committed backlog — the exact case the check exists for.)*

| finding | what to do |
|---|---|
| `NEW uncovered test id "x" … located by f#s but never exercised` | the flow reaches the element but never presses it: change the step's action, or add one that exercises it |
| `NEW uncovered test id "x"` | add a flow step that exercises it, or an exception with a real reason |
| `STALE flow reference [data-testid="x"]` | the app renamed or removed it: fix the flow's selector |
| `Ambiguous selectors` | the selector matches several ids, so it covers none: name the one you mean |
| `NEW page … not in known_routes.json` | `--register-routes`, review, then give it a flow |
| `NEW page no flow visits` | a `goto` (or a `url_contains` assertion) in a flow, or a route exception |
| `REMOVED page` | delete the inventory entry (or `"kind": "virtual"` for a non-file route) |
| `STALE navigation` | the flow's `goto` path no longer exists: fix the flow |
| `UNNEEDED exception` / `EXPIRED exception` | remove it / renew it with a fresh `expires` after review |
| `adoption-backlog entries are resolved but still listed` | `npm run coverage -- --app <id> --shrink-baseline` |
| `PARSE error in …` | the scan could not fully read a file: fix the syntax, or exclude a file the app does not build |
| exit 3 / BLOCKED | set the clone path (`APP_REPO_PATH_<ID>`), check it is the right repository, or fix `source.include` |

The JSON report (`reports/<app>/coverage.json`) carries everything above as
data: `verdict`, `blocking[]`, `testids.{newUncovered,existingUncovered,excepted,coveredIds,staleReferences,…}`
with `file`/`line`/`module`/`element`/`exercisedBy`, `routes.{newUnregistered,removed,newUncovered,…}`,
`exceptions.outstanding[]` with their status, `backlog`, and the source commit audited.

Registered apps and what each still needs: [REGISTERED-APPS.md](REGISTERED-APPS.md).
