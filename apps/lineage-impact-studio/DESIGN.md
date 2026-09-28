# Lineage Impact Studio design notes

## Product character

This is an analytic engineering workbench, not a marketing surface. It uses
AppKit semantic tokens and components, dense but readable type, explicit
status language, and a flat hierarchy of tabs, dividers, tables, and the one
diff surface that genuinely needs containment.

## Interface rules

- Use AppKit typography, spacing, colors, focus rings, and small/medium radii.
- Reserve semantic color for PASS, WARN, BLOCK, ERROR, validation, and commit
  outcomes.
- Keep body copy near 65–75 characters where practical and use horizontal
  scrolling only for the audit table and source diff.
- Keep status motion static. The only continuous motion is a progress spinner,
  and reduced-motion preferences suppress it.
- Do not add gradients, glass effects, glow, ornamental grids, decorative
  stripes, wide shadows, huge icons, oversized metrics, or nested card stacks.
- Keep restricted lineage anonymous. A placeholder must not expose asset names,
  counts, types, or the length of a hidden run.

## Impeccable Slop fallback review

Reviewed 2026-09-28 using Codex's built-in browser against
<https://impeccable.style/slop/> after `npx impeccable install` and registry
lookup were blocked by the configured private npm proxy. Impeccable was not
added as a runtime dependency.

The manual source and rendered-page review checked the catalog categories:
design-system consistency, visual detail, typography, color/contrast,
layout/space, motion, copy, imagery, and general quality. The implementation
uses no gradients, glassmorphism, glow, decorative background grid, accent
stripes, extreme radii, hero metrics, generic feature-card grid, marquee,
decorative animation, or placeholder imagery. Text below the AppKit `text-xs`
step was removed. Playwright covers keyboard tabs, narrow-screen stacking,
horizontal overflow, redaction, deep links, and stale commit handling.
