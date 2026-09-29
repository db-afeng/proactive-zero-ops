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

## Evidence-led assessment

The assessment reading order is deliberately: what changed, why it breaks,
what must be fixed, then review context. `AssessmentViewV2` contains only
strictly validated change facts, reason codes, fixed remediation kinds, and
authorized causal graph elements. Exact SQL expressions and repository paths
are excluded from that response and require a separate GitHub-authorized
request which revalidates repository read access and the assessed base/head
SHAs.

The graph has no decorative background or minimap. Proposed-code edges are
dashed; observed lineage is solid. Only verified breaks use destructive color,
while the proposed contract change uses warning color. The synchronized list
is the primary small-screen representation and opens evidence in an AppKit
sheet. Legacy v2 envelopes show a rerun-required message and never attempt to
reconstruct facts from model prose.

Loading progresses from a skeleton to explicit workspace/evidence checking at
10 seconds, then aborts at 90 seconds with a retry. Empty, stale, partial,
malformed, GitHub-disconnected, and stale-PR states all fail closed with direct
operational copy.

## Impeccable Slop fallback review

Reviewed 2026-09-29 against <https://impeccable.style/slop/> and the
`critique`, `layout`, `clarify`, and `harden` guidance. Impeccable is not a
runtime dependency.

The manual source and rendered-page review checked the catalog categories:
design-system consistency, visual detail, typography, color/contrast,
layout/space, motion, copy, imagery, and general quality. The implementation
uses no gradients, glassmorphism, glow, decorative background grid, accent
stripes, extreme radii, hero metrics, generic feature-card grid, marquee,
decorative animation, or placeholder imagery. Text below the AppKit `text-xs`
step was removed. The rendered desktop and 390px pages were reviewed for clear
reading order, 65–75 character prose widths, task grouping, actionable copy,
and overflow. Playwright covers graph filtering and controls, graph/list
selection, source authorization states, keyboard tabs, narrow-screen sheets,
light/dark semantic colors, reduced motion, redaction, legacy reassessment,
deep links, stale commit handling, and PR #4 visual baselines.
