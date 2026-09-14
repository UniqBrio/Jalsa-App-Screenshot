# Recordings — structured action logs from `npm run record`

One JSON file per recorded walkthrough, named `<module>.<flow>.json`. These are
COMMITTED: the converter (`npm run record:convert`) is deterministic over them,
which is what makes `npm run record:diff` meaningful — a changed conversion
means the recording or the converter moved, never a model's mood.

Values are redacted at record time (passwords, tel/email inputs, anything
shaped like an email or a 10-digit number, the .env PINs and mobile numbers) before
they can reach git history. Redacted values surface as TODOs in the draft.
Over-redaction costs a TODO to fill in; under-redaction is permanent.

Workflow:
  npm run record -- --flow members.member-filters    # walk it once, headed
  npm run record:convert -- --flow members.member-filters
  #  -> flows/members.member-filters.generated.yaml (a DRAFT — cannot execute)
  # review: fix TODO_SELECTORs, set run_tag: false (or drop the step), write the teardown,
  # delete the GENERATED header, then rename to flows/members.member-filters.yaml
  npm run record:diff -- --flow members.member-filters # what a re-convert would change

`record` refuses to overwrite an existing recording without --force.
Drafts (`*.generated.yaml`) are excluded from loadFlows(), so they cannot be
captured or documented until promoted by hand. Nothing in this project writes
to the app, so a draft that recorded a save, send or delete cannot be promoted.
