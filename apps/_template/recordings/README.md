# Recordings — structured action logs from `npm run record`

One JSON file per recorded walkthrough, named `<module>.<flow>.json`. The
converter (`npm run record:convert`) is deterministic over them, which is what
makes `npm run record:diff` meaningful — a changed conversion means the
recording or the converter moved, never a model's mood.

Values are redacted at record time (passwords, tel/email inputs, anything
shaped like an email or a 10-digit number, every account's login and secret
from this app's .env) before they are written. Redacted values surface as TODOs
in the draft. Over-redaction costs a TODO to fill in; under-redaction is
permanent.

Workflow:
  npm run record -- --app <app-id> --flow settings.edit-profile        # walk it once, headed
  npm run record:convert -- --app <app-id> --flow settings.edit-profile
  #  -> flows/settings.edit-profile.generated.yaml (a DRAFT — cannot execute)
  # review: fix TODO_SELECTORs, answer run_tag on each typed value, write the
  # teardown, delete the GENERATED header, then rename to flows/settings.edit-profile.yaml
  npm run record:diff -- --app <app-id> --flow settings.edit-profile   # what a re-convert would change

`record` refuses to overwrite an existing recording without --force.
Drafts (`*.generated.yaml`) are excluded from loadFlows(), so they cannot be
captured or documented until promoted by hand. A draft that recorded a save,
send or delete can only be promoted as a dummy write flow (flows/_SCHEMA.md).
