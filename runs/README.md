# Output folder — populated by `npm run capture -- --app <app-id>`.
# Layout: runs/<app-id>/<run-id>/run-summary.json
#         runs/<app-id>/<run-id>/<Device>/<module>-<flow>.flow-run.json
#         runs/<app-id>/<run-id>/<Device>/<module>/<flow>/<step-id>.<mode>.png
# Modes: viewport | full | element | failed | loading.
# Dry runs land in runs/<app-id>/.dry-run/<run-id>/.
# Everything here except this README is gitignored; runs are pruned after
# RUNS_RETENTION_DAYS (default 30).
