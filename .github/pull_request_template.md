## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The reasoning. If this fixes something subtle, explain what was wrong. -->

## Checks

- [ ] `npm run typecheck` is clean
- [ ] `npm run build` succeeds
- [ ] Tested against a real provider, or explained why that was not possible

<!-- If this adds a provider: -->
- [ ] Pricing is copied from the provider's own pricing page, linked here
- [ ] Free-tier claim matches what the provider publishes

<!-- If this touches the dashboard: -->
- [ ] Uses only token utilities — no hex codes, no `bg-gray-*`, no `dark:` variants
- [ ] Checked in both light and dark themes
