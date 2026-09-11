# Desktop parity: first web milestone

The current reference is `desktop/halftone_glitch_2.py`, supplied on 2026-09-09.
Earlier specs reference a different desktop revision; this milestone uses the
supplied file for the features below. It does not claim complete parity.

## Implemented

- Triangle vertices match the desktop's upright triangle. Cross bars occupy
  28% of the diameter, matching `_make_base_sprite` before raster rounding.
- Round represents the desktop's equivalent `dot` and `circle` modes.
- Circle outline keeps its ring inside the dot footprint; thickness is
  0.25–10 document pixels (default 1), scaled with preview/export resolution.
- Grayscale uses rounded 0.299 R + 0.587 G + 0.114 B luminance, optional
  inversion, and the desktop `_arr_gray_cached` gamma of 0.75. It renders only
  K, at the K angle. CMY controls are disabled without clearing their values.
  CMYK plate selection is restored when returning to color unless the user
  explicitly selects another plate. K visibility still controls the K proof.
- Grayscale ZIPs contain only the K PNG and job settings, at 240 DPI.
  Existing CMYK packages remain four PNGs. Missing new settings mean CMYK and
  1 px stroke; supplied invalid settings fail validation.

## Known differences and remaining work

Canvas antialiasing differs from Pillow/OpenCV sprite rasterization. Desktop
bitmaps round outline thickness to at least one pixel; the web deliberately
retains fractional document-pixel widths. Shapes stay upright in the web:
the desktop rotate-with-screen option is not included yet.

Existing web dot sizing remains `cell * sqrt(coverage) * 1.04`; the desktop
uses gamma 1.8 for radius mapping. The web also retains its white-paper cutoff
(luminance >= 250), contrast/exposure controls, minimum preview cell of 3 px,
and simplified CMYK separation. Consequently geometry and tonal-function
tests establish partial semantic parity, not pixel-identical print output.
Grayscale ramps validate the desktop luminance/gamma formula with the web
white cutoff recorded explicitly. Transparent artwork is composited onto
white in document rendering; desktop alpha handling can differ on inversion.

Later milestones: rotate-with-screen, remaining shape/smoothing controls,
custom SVG dots, advanced line hatching, ICC workflows, per-plate opacity and
colors, configurable/custom registration, diffusion, datamosh, slice shifts,
channel displacement, generative/ASCII/stereogram modes, layers, project
round-tripping, TIFF/SVG/PDF exports, and hosted project storage.

## Baseline review (2026-09-09)

The original and updated halftone engines were rendered side by side in
Windows Chromium 151.0.7922.34 using the existing sample and all five plate
views. Their PNG data URLs were identical. The original engine was read from
commit `c718840ff4d6cb1e008fa6ef2fbc3e9181367ca5` without changing the checkout.
Both differed from the repository's previously recorded hashes. A separate
`baseline-hashes.win32.json` records the verified Windows result; the original
baseline is retained for other platforms. Tests never silently write baselines.

The rendering harness now loads an external module with an absolute URL to
avoid the Windows/Vite HTML-proxy resolution failure. Its rendering inputs
are unchanged. The obsolete Next.js ESLint configuration was replaced with
TypeScript/React Hooks rules and explicit locked development dependencies.
