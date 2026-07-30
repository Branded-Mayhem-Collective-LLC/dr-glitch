# DR.GLITCH engine parity recovery

**Status:** Approved and in progress  
**Decision date:** 2026-07-29

## Decision

Dave's `drc_halftone_cmyk` behavior is the product oracle for print-critical
separation, document, placement, and export semantics. This decision
supersedes the earlier temporary constraint that froze the simplified browser
engine. Render-baseline changes are allowed only when a semantic parity test
explains the change.

The browser UI may keep improvements that do not alter print output, including
typed and scrubbed values, plate solo/hide, keyboard shortcuts, stage resets,
preflight, and job tickets.

## Delivered parity gate

- Deterministic maximum-GCR fallback: neutral colors separate to K instead of
  repeating on C, M, and Y.
- The original eight sheet sizes at 240 DPI, portrait/landscape orientation,
  native-size artwork placement, integer scale, offsets, Fit, Center, and
  horizontal/vertical mirroring.
- Document-aware preview and full-sheet production rendering.
- Dense-screen rejection above 2,000,000 estimated marks per plate; export
  stops instead of changing cell size.
- Composite and plate PNGs carry a 240-DPI `pHYs` chunk.
- Inverted output preserves white paper.

## Remaining recovery sequence

1. Restore all geometric screen shapes, outline stroke, rotate-with-screen,
   grayscale mode, and custom SVG dots.
2. Restore angle presets, moiré preview, per-plate opacity, and preview colors.
3. Restore registration size, offset, and custom registration SVG.
4. Restore TIFF, SVG, and PDF output packages.
5. Restore project round-tripping and import of compatible desktop project
   JSON before adding the hosted project library.

Every slice requires a failing semantic gate, browser interaction coverage,
the design-system suite, and an intentional render-baseline review.
