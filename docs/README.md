# Project documentation

- [PROPOSAL-any-app-any-device.md](PROPOSAL-any-app-any-device.md) — the design proposal behind device profiles, app profiles and dummy-account writes.
- [SELECTOR-GAPS.md](SELECTOR-GAPS.md) — how to record the test ids an app still needs.
- [COVERAGE.md](COVERAGE.md) — the test-id and page coverage checks: what they detect and cannot, exceptions and the backlog, local and CI runs, cost, reading a report.
- [REGISTERED-APPS.md](REGISTERED-APPS.md) — the apps registered under `apps/`, their source repositories, and what each still needs.

Generated per-app documentation is not written here: `npm run docs -- --app <app-id>`
writes `apps/<app-id>/docs/<Device>/<module>.md`.
