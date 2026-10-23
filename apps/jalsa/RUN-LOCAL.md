# Running the Jalsa capture on Windows (VS Code)

How to run the 30 Jalsa flows on your own machine, against Jalsa running locally on
`http://localhost:3000`. Commands are for the **PowerShell terminal in VS Code**.

> **Read-only, but not write-free.** The flows never save, send, print, pay or change a
> setting. Two things still touch the database, and both happen with every capture:
> signing in (the owner and captain PINs), and **opening a guest table page**. Every
> visit to `/t/<table>` from a new browser inserts a `guest_session` row
> (`resolveGuest`, `jalsa/src/lib/db/guest.ts`), so the guest flows run on Mobile only.
> The development database is the one that will become production
> (`jalsa/docs/registers/ENVIRONMENTS.md`).

> **PowerShell: type `npm.cmd`, not `npm`, whenever a command has `-- --flags`.**
> PowerShell's `npm` wrapper swallows the `--`, so npm eats `--app`, `--device`,
> `--flow` and `--headed` and the engine stops with "No app selected".
> `npm.cmd run validate -- --app jalsa` passes them through. (Or set `APP=jalsa` in the
> root `.env` and drop `--app`; the other flags still need `npm.cmd`.)

---

## 1. Prerequisites (once)

| # | What | Check |
|---|---|---|
| 1 | Node.js 20 or newer | `node -v` |
| 2 | Git | `git --version` |
| 3 | This repo, cloned | `git clone https://github.com/UniqBrio/Jalsa-App-Screenshot.git` |
| 4 | The app, cloned next to it (read it, never commit to it) | `git clone https://github.com/UniqBrio/JalsaRestaurant.git` |
| 5 | The app's own `jalsa/.env.local` (Supabase URL and keys, `SESSION_SECRET`) | the file Jalsa already runs with — nothing from it goes into this repo |
| 6 | **An owner PIN you chose yourself.** The seeded PIN `1234` is provisional and only opens "choose your own PIN"; the capture cannot sign in with it. Sign in once by hand at `http://localhost:3000/owner` and choose a PIN | you can reach the owner console with it |
| 7 | *Optional:* a captain PIN chosen the same way at `/staff` — without it the four captain flows are skipped | you can reach "My tables" with it |

A folder layout that works with the commands below:

```
C:\code\Jalsa-App-Screenshot      <- this repo
C:\code\JalsaRestaurant           <- the app (the REPO root, not jalsa\)
```

## 2. Install this repo (once)

```powershell
cd C:\code\Jalsa-App-Screenshot
npm install            # also downloads Playwright's Chromium (postinstall)
npm run typecheck
```

## 3. The two `.env` files (once)

**Root settings** (optional, no credentials): copy and adjust.

```powershell
Copy-Item .env.example .env
```

In `.env`, set the app and raise the step timeout. The Next.js dev server compiles each page the first time
it is opened, which can take longer than 15 seconds:

```
APP=jalsa
STEP_TIMEOUT_MS=30000
```

The file must be named exactly `.env` (Notepad may save it as `.env.txt`; check with `Get-ChildItem -Force .env*`).

**Jalsa credentials and values**: `apps\jalsa\.env`. This is the only place credentials are read
from, and git ignores it. Never commit it, and never paste a PIN anywhere else.

```powershell
Copy-Item apps\jalsa\.env.example apps\jalsa\.env
code apps\jalsa\.env
```

Fill in:

```
OWNER_PIN=<the PIN you chose in step 1.6>
# CAPTAIN_PIN=<optional, step 1.7>

# A FREE, in-service table: no open bill, and the queue open (see §6).
GUEST_TABLE=A5

# The app clone, forward slashes, no quotes:
APP_REPO_PATH=C:/code/JalsaRestaurant
```

Optional values the flows already default (override them in the same file only if the menu changed):
`GUEST_CATEGORY=biryani`, `STAFF_CATEGORY=biryani`, `MENU_SEARCH=biryani`,
`INACTIVE_TABLE=N10` (a table that is **out of service**; if N10 is back in service, opening it
creates a guest session, so set this to a table that is switched off).

## 4. Start Jalsa (every time)

In a **second** terminal:

```powershell
cd C:\code\JalsaRestaurant\jalsa
npm install            # first time only
npm run dev            # http://localhost:3000 — leave it running
```

Open `http://localhost:3000` in a browser once and wait for it to load, so the first compile is done.

## 5. Run, in this order

Back in the first terminal (`C:\code\Jalsa-App-Screenshot`):

```powershell
# 1. Offline checks: profile, every flow, selectors, read-only rules, host gate. Must end "All manifests valid".
npm.cmd run validate -- --app jalsa

# 2. Coverage, static (reads the app clone; no browser).
npm.cmd run coverage -- --app jalsa
#    Today this FAILS on exactly 7 new print ids, until you approve the exceptions in
#    apps\jalsa\EXCEPTIONS-PROPOSED.md (§1 there). Everything else passes.

# 3. Plan only: which flows run on which device. No browser, no network.
npm.cmd run capture:dry -- --app jalsa --all-devices

# 4. One flow, watched, to prove sign-in and the selectors on your machine.
npm.cmd run capture -- --app jalsa --device Laptop --flow owner/dashboard --headed

# 5. The real run, every flow, every device.
npm.cmd run capture:all -- --app jalsa --all-devices
```

Smaller runs, for fixing one area:

```powershell
npm.cmd run capture -- --app jalsa --module owner --device Laptop --headed
npm.cmd run capture -- --app jalsa --module guest --device Mobile
npm.cmd run capture -- --app jalsa --flow staff/table --device Mobile --headed
```

Guest flows are limited to Mobile (each guest visit creates a `guest_session` row), so
`--device Laptop` skips them.

## 6. Flows that need particular data

Most steps that depend on tonight's data are `optional` with a stated reason. When their
data is missing they are reported as **expected skips**, not failures. Four situations need
you to set things up:

| Flow | Needs | How |
|---|---|---|
| `guest/welcome`, `guest/menu`, `guest/help-sheets` | `GUEST_TABLE` free, in service, and the queue open (a closed queue shows "not taking new orders" instead of the welcome) | the normal run |
| `guest/order-in-progress` | `GUEST_TABLE` holding an **open bill with a round sent**; the last half needs the table to have **asked for the bill** | set `GUEST_TABLE` in `apps\jalsa\.env` to such a table, then run `npm.cmd run capture -- --app jalsa --flow guest/order-in-progress --device Mobile`, then set it back. The visit attaches this browser's guest session to that party's bill |
| `guest/paid-receipt` | `GUEST_TABLE` **paid within the re-scan window** | the same, with a table that has just paid |
| `staff/*` | `CAPTAIN_PIN` set; for `staff/table` the captain must own a table with an open bill | otherwise skipped (no PIN) or expected skips |

`GUEST_TABLE` is read only from `apps\jalsa\.env`, not from the shell.

## 7. Where the screenshots land

```
runs\jalsa\<run-id>\
  run-summary.json                          totals, failures, expected_skips
  <Laptop|Mobile|Tablet>\
    <module>-<flow>.flow-run.json           what every step did
    <module>\<flow>\<step-id>.viewport.png  what the user sees
    <module>\<flow>\<step-id>.full.png      the whole page (steps marked full)
    <module>\<flow>\<step-id>.failed.png    the screen when a step failed
    <module>\<flow>\<step-id>.loading.png   the page never settled
```

`runs\` is gitignored and pruned after 30 days. The first run of each flow sets its
fingerprint baseline (every step `new`).

## 8. When a step fails

1. **Read the console line.** Every failure names the flow, the step id and the selector, e.g.
   `✗ [owner/menu] step 070-edit-item (click) selector=[data-testid^="owner-edit-"] …`.
2. **Look at `<step-id>.failed.png`** and the flow's `flow-run.json` in the run folder.
3. **Re-run that one flow headed** and watch it:
   `npm.cmd run capture -- --app jalsa --flow owner/menu --device Laptop --headed`
4. Decide which case it is:
   - **The data is not there tonight** (no open bill, no printer, no suggestion…): if the step is
     already `optional`, it is an expected skip and not a failure. If a step that should be
     optional failed for this reason, tell Claude which one; do not add `optional: true` just to turn it green.
   - **Timeout on the first page** (dev server still compiling): open the page in a browser once, or
     raise `STEP_TIMEOUT_MS`, and run again.
   - **Sign-in fails**: check the PIN in `apps\jalsa\.env` works by hand at `/owner` or `/staff`. Stop after
     two failures: wrong PINs count towards the lock-out. A PIN that opens "choose your own PIN" is
     still provisional (step 1.6).
   - **Selector not found** (and the screen is right): the app renamed a test id. Search the app
     for the old id (`jalsa\src`), fix the selector in `apps\jalsa\flows\`, then run
     `npm.cmd run validate -- --app jalsa` and `npm.cmd run coverage -- --app jalsa`. Coverage reports a
     renamed id as a STALE reference.
5. **Never** fix a failure by pressing a Save / Send / Confirm button, by switching on writes, or
   by accepting the baseline. Accept the visual baseline only after you have looked at the
   screenshots: `npm.cmd run baseline:accept -- --app jalsa` (your call, after review).

After a full run, coverage can count what the browser really pressed instead of trusting the manifests:

```powershell
npm.cmd run coverage -- --app jalsa --evidence
```

## 9. Housekeeping

```powershell
npm.cmd run prune -- --app jalsa     # drop runs older than 30 days
git status                       # apps\jalsa\.env, .auth\, runs\ and fingerprints\ must never appear here
```
