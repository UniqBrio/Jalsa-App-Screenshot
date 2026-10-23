# Registered apps

What is registered under `apps/`, where each app's source is, and what each one
still needs. Figures are from the audit of 22-Oct-2026; re-run
`npm run audit:coverage -- --app all` for today's.

| app | source repository | router | interactive ids | pages | flows | capture sign-in | CI source access |
|---|---|---|---|---|---|---|---|
| `jalsa` | `UniqBrio/JalsaRestaurant` (public; the app is `jalsa/`) | Next.js App Router, `jalsa/src/app` | 543 (0 covered) | 6 | none yet | `pin-only`, owner at `/owner`, captain at `/staff` | public — works |
| `rosifit` | `UniqBrio/RosiFit` (public) | Expo Router, `app/` | 231 (48 covered) | 30 (18 visited) | 20, ported | `mobile-pin` | public — works |
| `uniqbrio` | `UniqBrio/UniqBrio-Mobile-App` (**private**) | Expo Router, `app/` | 1107 (0 covered) | 40 (+3 redirects) | none yet | `mobile-pin` + Verify (`submit`) | needs `APP_SOURCE_READ_TOKEN` |

Each app's uncovered ids and pages on that date are its **adoption backlog**
(`config/coverage-baseline.json`), taken with `--init-baseline` on 22-Oct-2026:
debt, listed in every report, and it can only shrink. Every element or page
added after that date needs a flow or a reasoned exception.

Local clone paths are per machine and not committed: set
`APP_REPO_PATH_JALSA`, `APP_REPO_PATH_ROSIFIT`, `APP_REPO_PATH_UNIQBRIO` (or
`APP_REPO_PATH` in each `apps/<id>/.env`). For Jalsa this is the
**JalsaRestaurant repo root**, not `jalsa/`.

## jalsa

- Profile written from the source: the PIN keypad (`staff-pin-input`,
  `staff-key-{digit}`), the signed-in markers `owner-console` / `staff-app`,
  and `staff-choose-pin` for a provisional PIN. `baseUrl` is the Vercel
  deployment `https://jalsa-restaurant-phi.vercel.app`; `APP_URL=http://localhost:3000`
  in `apps/jalsa/.env` captures a local `npm run dev` instead.
- `routes.map.json` was written from the real tree: `home`, `guest`, `staff`,
  `owner`, plus `_global` for `components/`, `lib/`, `theme/`.
- **To capture:** the seeded PIN `1234` is provisional and only opens *choose
  your own PIN*. Choose a PIN by hand once, put it in `apps/jalsa/.env` as
  `OWNER_PIN` (and optionally `CAPTAIN_PIN`), run `npm run dev` in `jalsa/`,
  then write flows.
- Read-only: `dataIsolation` is `none`. The development database is the one
  meant to become production.

## rosifit

- Profile, 20 flows, `routes.map.json` and `known_routes.json` were ported
  unchanged from `UniqBrio/RosiFit-App-Screenshot`. All 20 flows validate on this
  engine.
- `--register-routes` added 10 pages that were missing from its inventory:
  `/change-mobile`, `/course/edit`, `/holiday`, `/member/edit`, `/member/import`,
  `/offering/edit`, `/register`, `/send/result`, `/staff/pin`, `/subscription`.
- Two files resolve to `/`: `app/index.tsx` (sign-in) and
  `app/(tabs)/index.tsx` (Overview). Reported as a possible duplicate route.
- `app/holiday.tsx`, `app/subscription.tsx` and 21 test ids are in no
  `routes.map.json` module (`unmapped`): the ported map predates them. Add them
  to a module so the capture skip filter sees their changes.
- **Credential hygiene:** `RosiFit-App-Screenshot/.env.example` carries a real
  sign-in number and PIN. Rotate the PIN and blank the file there. This
  profile's `.env.example` has no values.

## uniqbrio

- `appName` is "UniqBrio Mobile": the app shares its name with the GitHub
  organisation, and the app-agnostic check (`security-policy.test.ts`) would
  otherwise flag the organisation name in `package.json`.
- Sign-in selectors are from `app/login.tsx`: `login-phone` → `login-get-otp`
  → `login-otp` → `login-verify-otp`; signed in = any `tabbar-*`. `baseUrl` is
  `TEST_APP_URL` from `UniqBrio_App_Screenshot_Capture`.
- `routes.map.json` was written from the real Expo Router tree. The map in
  `UniqBrio_App_Screenshot_Capture` was a first-pass guess naming folders that do
  not exist.
- **Flows not ported:** the 12 flows in `UniqBrio_App_Screenshot_Capture` are
  Phase-1 placeholders ("selectors … not verified"), and several write data
  through a cleanup module this engine does not have. Port each one through
  `npm run validate` once its selectors are verified against the app.
- **CI prerequisite:** the source repo is private. Add the repository secret
  `APP_SOURCE_READ_TOKEN` (read-only *Contents* on `UniqBrio/UniqBrio-Mobile-App`).
  Until then its nightly job reports BLOCKED.
- Pages worth a look: `/billing/BillingScreen` is a component file inside the
  router folder, so Expo Router serves it as a URL. `/formsheet`, `/modal` and
  `/transparent-modal` are in no module.
