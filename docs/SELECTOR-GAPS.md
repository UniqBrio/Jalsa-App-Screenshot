# Selector Gaps — testids the app needs

Targets in the capture flows that have **neither a `testID` nor a usable
accessible name (`accessibilityRole` + `accessibilityLabel`)** in the RosiFit
app. Per the selector policy we do **not** fall back to CSS / XPath / nth-child
/ text — instead the step takes a `selector_exempt` (or is left out) and the
gap is recorded here so the `testID` can be added to
https://github.com/UniqBrio/RosiFit.

First written 2026-09-12 from the app source (commit `0e262dd`), before any
run against the live app. Expect this list to grow after the first headed run.

## How to clear a gap
1. Add the requested `testID` to the element in the app repo.
2. Re-point / re-enable the step in the flow manifest.
3. Re-run `npm run capture -- --headed --flow <mod>/<flow>` and confirm it passes.

---

## Known gaps (from the source read)

| Flow | Where | Element | Has now | Requested `testID` |
|---|---|---|---|---|
| `more/more-menu` | `/more` | The settings rows (Branches, Staff & access, …) | `accessibilityRole="button"` + label `"<Label>, <meta>"` — usable via `role=button[name=/^Branches/]`, but the meta (a count, a theme name) is part of the name | `more-row-<slug>` |
| `more/more-menu` | `/more` | The account card | label `"<name>, <role>. Open your profile"` — matched on its suffix | `more-profile` |
| `more/*`, `signin/*` | floating pill on tab screens | Home · Reports · More | `role="tab"` + label only (the `shell-nav-*` ids exist only on pushed screens) | `nav-pill-<label>` everywhere |
| `members/*`, `weekly/*` | `/members`, `/weekly` | Member rows (`MemberRow`) | one-sentence label starting with the name — matched on `" expected, "` | `member-row-<id>` |
| `attendance/course-detail` | `/course/[id]` | Roster member rows | `course-member-<id>` exists, but `course-member-` is also the prefix of `-search`, `-select-`, `-edit-` … so a prefix match cannot pick a row; matched by label `", active. "` instead | a distinct prefix, e.g. `course-row-<id>` |
| `members/member-directory` | `/members` | Search box | `accessibilityLabel="Search members"` — fine, but a `testID` would survive a copy change | `members-search` |
| `members/member-directory` | `/members` | Add button | `<Button label="Add">` — name only | `members-add` |
| `more/profile` | `/profile` | Change My PIN | `<Button label="Change My PIN">` — name only | `profile-change-pin` |
| `signin/forgot-pin` | `/forgot-pin` | Back to sign in | four different ids across the screen's states (`forgot-pin-back`, `-requested-back`, `-staff-back`, `-locked-back`) — matched by name | one id, or keep the name stable |
| `notifications/*` | header sheet | Close control | the scrim, labelled `"Close Notifications"` | `sheet-close` |

None of these blocks a flow today: every one has an on-policy role/name
selector. They are listed because a name is a piece of copy, and copy changes.
