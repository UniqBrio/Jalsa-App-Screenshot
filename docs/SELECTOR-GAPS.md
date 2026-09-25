# Selector gaps — test ids an app still needs

Flows may only use `[data-testid="…"]` or `role=<role>[name="…"]` selectors.
When a control a flow needs has **neither a test id nor a usable accessible
name**, we do not fall back to CSS, XPath, `nth-child` or text. The step takes a
`selector_exempt` with a reason (validate warns about it on every run), or is
left out, and the gap is recorded so the test id can be added to the app.

Keep one gap list **per app**, next to its profile:
`apps/<app-id>/docs/SELECTOR-GAPS.md` (local, like the rest of the profile).

## What counts as a gap

- **No test id and no name.** An icon-only button, an unlabelled row, a custom
  control with no role. Nothing on policy can target it: blocking.
- **A name that carries data.** `role=button[name="Notifications, 3"]` works
  until the count changes; the flow has to fall back to a regex on the stable
  prefix. Works, but fragile: request a test id.
- **An ambiguous prefix.** `[data-testid^="order-"]` also matches
  `order-search` and `order-filter`, so a prefix cannot pick "the first order
  row". Request a distinct prefix such as `order-row-<id>`.
- **Several ids for one control.** The same Back button with a different id in
  each state of a screen. Request one id, or keep its name stable.

## Template

```markdown
| Flow | Where | Element | Has now | Requested test id |
|---|---|---|---|---|
| `settings/team` | `/settings/team` | Member rows | label only, starts with the person's name | `team-row-<id>` |
| `orders/list` | `/orders` | Search box | `aria-label="Search orders"` — fine, but copy can change | `orders-search` |
```

## How to clear a gap

1. Add the requested test id to the element in the app repo (React:
   `data-testid`; React Native / react-native-web: `testID`).
2. Re-point the step to it and drop any `selector_exempt`.
3. Re-run it: `npm run capture -- --app <app-id> --flow <module>/<flow> --headed`.
4. Remove the row from the app's gap list.
