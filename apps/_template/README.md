# App profile template

Copy this folder to `apps/<app-id>/` to onboard an app. Everything the engine
needs to know about one app lives in its profile; the engine code knows about
none of them.

```
apps/<app-id>/
  app.config.json        identity, hosts, login adapter, accounts, dummy fingerprint  (fields explained in its $comment keys)
  .env                   this app's credentials only — copy .env.example; never committed
  flows/                 flow manifests: <module>.<flow>.yaml  (reference: flows/_SCHEMA.md)
  flows/_drafts/         discovery / recorder drafts, never executed
  config/
    routes.map.json      module -> flows -> app source globs (git-diff skip filter)
    known_routes.json    the app's routes, for coverage and discovery
    pii-regions.json     evidence-mode PII classification
    manual-review-items.json  open questions for the evidence index
  fingerprints/          baseline.json + last-run.json, written by runs
  recordings/            npm run record output
  docs/                  npm run docs output (created on first use)
  .auth/                 saved sessions (created on first sign-in) — secret
```

## Onboard in 10 minutes

1. `cp -r apps/_template apps/my-app`
2. Edit `apps/my-app/app.config.json`: `appName`, `appDescription`, `baseUrl`,
   `allowedHosts`, `framework`, `theme`, the `loginAdapter` selectors, and the
   `accounts` (identity → the `.env` names of its login and secret).
3. `cp apps/my-app/.env.example apps/my-app/.env` and fill in the credentials.
4. Replace `flows/home.home-overview.yaml` with the app's flows — write them, or
   `npm run record -- --app my-app --flow <module>.<flow>` and convert. Add each
   module to `config/routes.map.json` and each route to `config/known_routes.json`.
5. `npm run validate -- --app my-app` — offline; fix every error.
6. `npm run capture -- --app my-app --device Mobile --headed --flow home/home-overview`
   to watch one flow, then `npm run capture -- --app my-app --all-devices`.

Everything under `apps/` except this template is gitignored. The profile holds
real hosts, selectors and saved sessions; keep it on the machine that captures.

## The dummy account (optional)

For pages behind a write, provision a dummy account **in its own tenant**,
fill in `dummyAccount` in `app.config.json` and the `DUMMY_*` credentials, add
the dummy tenant's host to `writeAllowedHosts`, and run with `WRITE_MODE=dummy`.
The rules a write flow must follow are in `flows/_SCHEMA.md` → *Dummy write flows*.
