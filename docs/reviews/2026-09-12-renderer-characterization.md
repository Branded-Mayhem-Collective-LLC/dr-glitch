# Renderer and export characterization — baseline c079a21 (P0 transfer)

Audience: the multi-layer engine team (src/render), the compatibility-adapter
author, and the regression-oracle author. Every claim carries a file:line
reference into the current worktree state of the stable baseline
(`src/studio/halftone.ts` sha-pinned by
`tests/e2e/render-regression.spec.ts:10` as the approved renderer).

All line numbers refer to files under
`/home/michael/worktrees/halftone-web/task-20260912-workstation/`.

---

## 1. Top-level data flow: `renderHalftone`

`renderHalftone(source, target, settings, options)` — `src/studio/halftone.ts:784-930`.

1. **Custom-dot precondition** (`halftone.ts:790`): throws if
   `dotShape === "custom"` without `settings.customShape`. Stamps must be
   prepared asynchronously beforehand (`prepareCustomShape`,
   `src/studio/custom-shape.ts:98-109`); the render loop itself is fully
   synchronous.
2. **Target dimensions** (`halftone.ts:795-812`):
   - With `options.document`: sheet px = `getSheetPixelDimensions(sheetSize,
     orientation)` (`src/studio/document-model.ts:41-54`), i.e.
     `Math.round(inches * 240)` per axis, orientation swaps axes. Then
     `getDocumentTargetDimensions` (`halftone.ts:717-739`) fits the sheet into
     `options.width/height` with `scale = min(w/sheetW, h/sheetH)` (or a single
     axis when only one is given), rounding each axis independently
     (`Math.max(1, Math.round(...))`, `halftone.ts:735-738`). Non-finite or
     ≤0 scale falls back to 1 (`halftone.ts:733`).
   - Without a document: target = `options.width/height ?? natural size`
     rounded, min 1 (`halftone.ts:808-811`).
3. **Canvas init** (`halftone.ts:815-817`): sets `target.width/height`
   (clearing it), gets a 2d context with `{ alpha: options.transparent ?? false }`.
4. **Paper fill** (`halftone.ts:820-823`): unless `transparent`, fills the
   whole target with `options.paper ?? "#eeeae0"`.
5. **Black-paper white matte** (`halftone.ts:824-845`): if not transparent and
   `paper` lowercases to exactly `"#000000"` or `"#111214"`, a **white
   rectangle** is painted; with a document it covers only the artwork
   placement rect (`calculateArtworkPlacement`, scaled by `width/sheetW`,
   `halftone.ts:826-841`), without a document it covers the full canvas
   (`halftone.ts:843`). This is the only "white matte" behavior in the system
   and it applies to the *proof/composite background*, never to plates
   exported with `transparent: true` (both fills are guarded by
   `!options.transparent`).
6. **Sampling canvas** (`halftone.ts:847-856`):
   - `sampleScale = options.preview ? Math.min(1, 1100 / max(width, height)) : 1`
     (`halftone.ts:848-850`). **The 1100px preview clamp**: preview sampling
     never exceeds 1100 px on the longer target edge; export always samples at
     full target resolution.
   - Sample canvas = `round(width*sampleScale) x round(height*sampleScale)`,
     min 1 per axis, context created with `willReadFrequently`.
7. **Artwork rasterization into the sample canvas** (`halftone.ts:858-874`):
   - Document path: sample canvas is first filled `#ffffff`
     (`halftone.ts:859-860`) so the sheet is white regardless of the proof
     background choice; then `drawDocumentArtwork` (`halftone.ts:741-782`)
     places the artwork.
   - No-document path: `drawImage(source, 0, 0, sampleW, sampleH)` — the
     source is **stretched to fill** the sample canvas with **no white
     underpaint** (`halftone.ts:873`). Consequence: transparent source pixels
     read back as RGBA `(0,0,0,0)` from `getImageData`, and `coverageFor`
     ignores alpha entirely, so **transparent pixels count as full black ink**
     in the no-document path. In the document path they composite over white
     and become paper. This is the central "source alpha is implicit" hazard
     the plan's explicit-alpha requirement targets.
8. **Placement math** (`drawDocumentArtwork`, `halftone.ts:741-782`):
   - `calculateArtworkPlacement` (`document-model.ts:64-81`):
     `width = max(1, trunc(sourceW * scalePercent/100))` (truncation, not
     rounding), same for height; `x = floor((sheetW - width)/2)`,
     `y = floor((sheetH - height)/2)` — center placement with floor bias.
     There is no offset support in the model; artwork is always centered.
   - Placement is computed in **sheet px** then scaled by
     `sampleW/sheetW` and `sampleH/sheetH` into sample-canvas space
     (`halftone.ts:759-764`).
   - **Mirror** (`halftone.ts:768-779`): horizontal mirror translates to
     `(x+width, y)` and scales `(-1, 1)`; vertical to `(x, y+height)` and
     `(1, -1)`. Mirroring happens **before sampling**, i.e. before separation,
     glitch, and screening; the screen lattice and registration marks are NOT
     mirrored. This is artwork-mirror semantics, not full press-mirror
     semantics — the new `OutputDefaultsV1.pressMirror` must not be assumed
     equivalent.
9. **Pixel readback** (`halftone.ts:876-881`): one `getImageData` of the whole
   sample canvas. All downstream math operates on this `ImageData`.
10. **Scale rules** (`halftone.ts:882-889`):
    - `renderScale = width / sheetW` (document) or `width / naturalW`
      (no document). Cell size and stroke width are multiplied by this so a
      preview at reduced target size shows the same physical screen
      (`halftone.ts:671`, `:709`).
    - `minimumCellSize`: **3** for document preview, **0.01** for document
      export, and **3** whenever there is no document (`halftone.ts:885-889`,
      mirrored for SVG at `halftone.ts:992`). The 3px floor exists so preview
      lattices stay drawable; export must never re-apply it or dense screens
      change geometry between preview and film.
11. **Plate loop** (`halftone.ts:891-927`):
    - `activePlates = plate === "composite" ? processPlates(settings) : [plate]`
      where `processPlates` returns `["black"]` in grayscale else all four
      CMYK plates in fixed order C,M,Y,K (`halftone.ts:60-69`).
    - `monochrome = grayscale || (options.monochromePlate && plate !== "composite")`
      (`halftone.ts:893`). Monochrome renders ink `#111214` with
      `source-over`; color renders the plate hue (`PLATE_META`,
      `halftone.ts:71-76`) with **`multiply`** (`halftone.ts:498-499`,
      `:688-690`, `:923`). Note: grayscale forces monochrome even for
      composite; a grayscale composite is dark-ink source-over.
    - **Opacity layer path** (`halftone.ts:894-926`): when
      `clamp(settings.opacity) < 1`, each plate is rendered **opaque onto its
      own scratch canvas** (settings cloned with `opacity: 1`,
      `halftone.ts:902`) and then composited onto the target with
      `globalAlpha = opacity` and `multiply`/`source-over`
      (`halftone.ts:920-926`). At `opacity === 1` plates draw directly into
      the target context. The per-plate scratch flattening means overlapping
      dots *within one plate* don't double-darken, but plates still multiply
      against each other; this exact structure is what "opacity multiplies
      alpha exactly once" must reproduce per layer.
12. **Registration final pass** (`halftone.ts:929`, `drawRegistration`
    `halftone.ts:615-649`): drawn last, on every render where
    `options.registration` is true — **including plates whose ink is hidden**
    and including composite. `source-over`, `globalAlpha 0.7`, stroke
    `#121416`, `lineWidth = max(0.5, weight)` (`halftone.ts:626-629`).
    Default size `max(7, round(min(w,h)*0.014))`, default offset
    `max(14, round(min(w,h)*0.035))` (`halftone.ts:619-620`) — the UI always
    overrides with 120/120/2 (`HalftoneStudio.tsx:146-148`). Modes:
    `corners` = 4 points inset by offset; `centered` = top/bottom center
    (`halftone.ts:632-634`). Custom registration shape: stamp rasterized at
    `size*2` in `#121416` and drawn at `size` (`halftone.ts:630`, `:636-638`);
    otherwise circle r = `size*0.58` plus crosshair of half-length `size`
    (`halftone.ts:640-646`).

## 2. Halftone dot pass: `renderPlateDots` (`halftone.ts:651-715`)

- **Visibility gate** (`halftone.ts:664`): returns immediately (draws
  nothing) when `!settings.visible[plate]` or grayscale-and-not-black. In a
  composite this silently blanks hidden plates; the canvas stays at full job
  dimensions.
- **Screen lattice** (`halftone.ts:667-696`): rotated square grid,
  `cell = max(minimumCellSize, cellSize * renderScale)` (`halftone.ts:671`),
  angle per plate from `settings.angles`, iterated in rotated (u,v) space over
  `half = diagonal/2 + cell` and mapped through
  `x = centerX + u·cos − v·sin`, `y = centerY + u·sin + v·cos`
  (`halftone.ts:692-695`). **The lattice is anchored at the target-canvas
  center** — which equals the artboard center because the target is always
  the full sheet. The multi-layer engine's "screens anchor to artboard
  center" requirement matches this only as long as plates are rendered at
  full artboard extent; any tiling must keep absolute artboard coordinates.
- **Sampling** (`halftone.ts:698-704`): each lattice point maps to
  `round(x/width * sampleW)` clamped into the sample grid (nearest-neighbor,
  round-half-up), reads the precomputed coverage field.
- **Artwork-bounds clipping** (`halftone.ts:672-678`, `:702-703`): lattice
  points outside `visibleContentBounds(pixels)` scaled to output space are
  skipped. `visibleContentBounds` (`halftone.ts:311-330`) scans the sample
  pixels and keeps the bounding box of pixels with **luminance < 250**
  (`0.299r+0.587g+0.114b`, `halftone.ts:319-320`); an all-white image falls
  back to the full canvas (`halftone.ts:327-329`). **Hidden coupling #1**:
  this white-threshold bbox is computed on the *flattened white-backed
  sample*, so it conflates "artwork extent" with "non-white content". A
  multi-layer engine with real source alpha must derive per-layer bounds from
  alpha, and the compatibility adapter must reproduce the ≥250 bbox for
  parity or dots near white margins will appear/disappear.
- **Dot size** (`halftone.ts:705`): `dotSize = cell * sqrt(coverage) * 1.04`
  (area-linear with 4% overlap). Threshold: `drawDot` returns for
  `size <= 0.12` (`halftone.ts:574`); custom stamps use the same 0.12 gate
  (`halftone.ts:707`).
- **Shapes** (`drawDot`, `halftone.ts:566-613`): square, diamond, triangle
  (apex up, desktop vertex parity per
  `tests/unit/desktop-parity.test.ts:49-59`), cross with 28%-of-size bars
  (`halfBar = size*0.14`, `halftone.ts:595-597`), circle-outline with stroke
  drawn *inside* the footprint via an even-odd style double-arc
  (`inner = max(0, radius - strokeWidth)`, hole closes when stroke ≥ radius,
  `halftone.ts:598-605`), line = rounded rect `size × 0.32·size` rx
  `0.16·size` (`halftone.ts:607`), default round. `strokeWidth` is passed
  pre-multiplied by `renderScale` (`halftone.ts:709`).
- **Custom stamp** (`halftone.ts:683-685`, `customShapeStamp`
  `src/studio/custom-shape.ts:118-137`): stamp resolution
  `min(2048, max(16, ceil(maxDotSize*2)))`, tinted via `source-in`, cached per
  `(color, resolution)` with a 12-entry FIFO eviction
  (`custom-shape.ts:134`). Stamp requested at `cell * 1.04`
  (`halftone.ts:684`), drawn at `dotSize` centered.

## 3. Coverage model: `coverageFor` (`halftone.ts:541-564`)

- **White cutoff**: luminance ≥ 250 ⇒ coverage 0 on *every* plate, in every
  mode, **including inverted output** (`halftone.ts:548-549`; asserted by
  `tests/unit/halftone-math.test.ts:51-64`). Hidden coupling #2: this is the
  "background never creates ink" rule *and* the reason black-paper proofs
  need the white matte. Any layer whose flattening background is not white
  (e.g. transparent-over-nothing) bypasses it — see §1.7.
- **Grayscale** (`halftone.ts:551-556`): non-black plates ⇒ 0; K uses Pillow
  L luminance rounded to integer, `/255`, optional polarity invert *before*
  gamma, then `pow(·, 0.75)` (desktop `_arr_gray_cached` parity;
  `desktop-parity.test.ts:28-39`).
- **CMYK** (`halftone.ts:558-563`): `rgbToCmyk` (`halftone.ts:527-539`) with
  **maximum GCR** (K = min(C,M,Y), subtracted from CMY). Then:
  `value === 0 && !invert ⇒ 0`; invert ⇒ `1 - value`. Note a zero channel
  *does* invert to 1 on non-white artwork (`halftone-math.test.ts:66-69`).
  Old `settings.invert` is a per-coverage polarity, applied before screening
  — not an output-space inversion. The new `OutputDefaultsV1.polarity`
  ("inverts at output") is a *different* operation; the adapter must map
  legacy invert to coverage-space inversion or grayscale gamma parity breaks
  (gamma is applied after invert at `halftone.ts:555`).

## 4. Glitch pipeline order and determinism

`buildCoverageField` (`halftone.ts:235-250`) fixes the halftone-mode order:

1. per-pixel `coverageFor` (`halftone.ts:237-242`),
2. `buildGlitchField` (`halftone.ts:188-233`),
3. `applyFrayedEdges` (`halftone.ts:243-249` → `:252-309`).

`buildGlitchField` internal order (per channel, `channelIndex =
PLATES.indexOf(plate)` — grayscale K is index 3):

1. **Coordinate remap** via `glitchSamplePoint` (`halftone.ts:108-138`), in
   this order: horizontal slice shift (band = `floor(y/sliceSize)`, offset =
   `(band*37) % (2s+1) − s`), vertical slice shift (`band*53`), grid warp
   (`sin(y/scale)`, `cos(x/scale)`), smear (`((x*17+y*31) % smearLength) ·
   drag`, axis chosen by `smearVertical`), block shift jitter
   (`(floor(coord/block) % 3 − 1) · shift · block · 2`), then a per-channel
   desync `channelDesync · (channelIndex+1) · block · 2` added to X at sample
   time (`halftone.ts:200-201`). Samples clamp-round into the field
   (`halftone.ts:137`, `:140-144`).
2. **Macroblock pass** (`halftone.ts:205-231`): per block of
   `max(4, blockShiftSize)`, hash
   `(x*73856093 + y*19349663 + channelIndex*83492791) >>> 0`,
   `probability = (hash % 1000)/1000`; corrupt ⇒ zero the block when
   `probability < dropout·corrupt` else quantize to quarters
   (`round(v*4)/4`); block shift ⇒ re-sample with
   `dx = (((hash>>>8) % 5) − 2)·shift·block`, dy likewise from `hash>>>16`.
3. **Bitmap sort** (`bitmapSortField`, `halftone.ts:146-186`): seeded LCG
   `state = imul(state,1664525)+1013904223 >>> 0`, **seed = `99 +
   channelIndex*17`** (`halftone.ts:232`); Fisher-Yates selects
   `floor(lineCount·amount)` lines; within each line, runs of values `> 0.1`
   are sorted ascending.

`applyFrayedEdges` (`halftone.ts:252-309`): content rows/columns are those
containing any field value `> 0.1`; insets are
`hash(y*17+701) % (maxShift+1)` etc. with
`hash(v) = imul(v ^ 0x9e3779b9, 2654435761) >>> 0` (`halftone.ts:282`);
`maxShift = floor(amount*1.5)` and insets are only applied when
`< max(10, maxShift*2)` (`halftone.ts:274-277`).

**All seeds are pure functions of (sample-space x, y, channelIndex, settings)
— there is no RNG state outside `bitmapSortField`'s fixed seed.** Because
coordinates are sample-canvas coordinates, preview (≤1100px sampling) and
export (full-res sampling) produce *different* glitch textures by design;
"document-scale sizes, noise, glitches match preview/export" in the plan is
currently only true for exports, not for the clamped preview. The oracle must
compare export-path renders, not preview-path renders.

## 5. Diffusion pipeline: `buildDiffusionField` (`halftone.ts:425-480`)

Order (asserted by `tests/unit/halftone-math.test.ts:103-134`):

1. Coverage per pixel (same `coverageFor`, `halftone.ts:430-436`).
2. `preprocessDiffusionField` (`halftone.ts:375-423`): **datamosh first** —
   `buildGlitchField` with `sliceShift/verticalSliceShift/gridWarp` forced to
   0 (`halftone.ts:382-387`; those three glitches are halftone-mode-only),
   then denoise (box blur radius `max(1, round(1+denoise*2))` with
   edge-weighted blend, `halftone.ts:390-401`) or negative-denoise
   deterministic noise (`deterministicNoise`, `halftone.ts:347-351`, hash of
   (x+1, y+1, channelIndex+1) with 73856093/19349663/83492791 then
   2246822507 finalize, amplitude `-denoise*0.18`), then unsharp mask
   (`strength`, box blur radius `max(1, round(sharpenRadius))`,
   `halftone.ts:411-422`).
3. **Serpentine error diffusion** (`halftone.ts:450-478`): rows alternate
   direction (odd rows right-to-left, kernel dx mirrored,
   `halftone.ts:451-453`, `:470`). Per pixel, additive perturbations *before*
   quantization: modulation offset (`diffusionOffset`, `halftone.ts:332-345`,
   scaled by `modStrength * 0.25` at `:456`), directional bias
   (`sin(x·cosθ + y·sinθ) · bias · 0.08`, `:457-460`), broken kernel
   (`(((x*7+y*11)%5)−2) · bk · 0.03`, `:461`), error overflow (`+eo·0.12`
   when `(x+y)%9===0`, `:462`), diffusion reset (row value resets to source
   every `max(2, round(24 − reset·20))` rows, `:463`), cross-channel bleed
   (constant `+ccb·0.02`, `:464`). Then `value = clamp(value + accumulated
   error)`, quantized to `round(v·(levels−1))/(levels−1)` with
   `levels = max(2, round(levels))` (`:448`, `:466-467`), and error
   `(value − quantized) · intensity` distributed by the kernel
   (`kernels` table `halftone.ts:439-445`; `"none"` = empty kernel = pure
   quantization; unknown names fall back to Floyd-Steinberg `:447`).

Raster presentation (`renderDiffusionPlate`, `halftone.ts:482-507`): pixel
threshold **≥ 0.5** paints a rect of `pixelW+0.25 × pixelH+0.25` (quarter-px
overlap kills hairline seams, `:502-503`), plate color or `#111214`,
multiply vs source-over as in §1.11. Diffusion ignores
`visibleContentBounds` — the whole sample grid is eligible.

## 6. SVG plate export: `renderPlateSvg` (`halftone.ts:932-1031`)

- Same dimension math as raster (`:939-946`); same sampling-canvas
  construction including the 1100 preview clamp if `options.preview` is set
  (`:955` — the UI never sets preview for SVG export).
- **Hidden/suppressed plates still emit a full-dimension SVG** with only
  registration content (`:952-953`; verified by
  `tests/e2e/svg-export.spec.ts:80-100`).
- Halftone path (`:985-1013`): identical lattice, content-bbox clip
  (`:1003-1004`), sampling (`:1005-1006`), size formula and 0.12 threshold
  (`:1007-1008`). **Grid budget enforced up front**:
  `estimateGridPoints(width, height, cell, angle) > MAX_EXPORT_GRID_POINTS
  (2,000,000)` throws (`:995-997`; constants `:78-84`).
  `estimateGridPoints` (`:509-525`) = rotated-bounding-box columns × rows.
- Diffusion path (`:970-984`): horizontal **run-length coalescing** of ≥0.5
  pixels into `<rect>`s with the same quarter-px overlap (`:982`); throws
  past `MAX_DIFFUSION_SVG_RUNS` (2,000,000) runs (`:981`).
- Output document (`:1031`): width/height in **inches**
  (`(px/240).toFixed(4)in`), viewBox in px, all marks in one group
  `fill="#000000" stroke="none" opacity="{clamp(settings.opacity)}"` —
  **SVG plates are always black regardless of `monochromePlate` or plate
  hue**, and opacity is a single group attribute (flat, not per-mark;
  matches the raster scratch-canvas flattening semantics).
- Custom dots become a `<symbol id="dot-shape">` from the *prepared
  sanitized* SVG (`svgSymbol`, `:1034-1039`) referenced by `<use>`
  (`:1041-1043`); registration custom marks a second symbol
  (`registration-shape`, `:1022-1024`). Built-in registration:
  `fill=none stroke=#000000` group, opacity 0.7 per mark (`:1026-1028`) —
  note stroke color differs from raster (`#000000` vs `#121416`).
- `svgDot` geometry (`:1045-1057`) mirrors `drawDot`, except circle-outline
  emits a stroked circle at `r = radius − strokeWidth/2` only when
  `strokeWidth < radius`, else a filled circle (`:1055-1056`).

## 7. Export flows in the shell (`src/studio/HalftoneStudio.tsx`)

Preview render (`HalftoneStudio.tsx:183-206`): full sheet fit into 980 px
(`maxDimension`, `:189-190`), paper `#111214` (black) / `#F4F1E9` (white),
`registration` + all registration params, `monochromePlate: true`,
`preview: true`. rAF-debounced with async stamp preparation
(`:208-224`). Everything renders on the main thread; there is no draft/
commit split today.

Preflight gate before every export (`:633-641`): halftone —
worst-plate `estimateGridPoints` at full sheet > 2,000,000
(`screenLoad`, `:397-411`); diffusion —
`sheetW·sheetH·enabledPlates > MAX_DIFFUSION_RASTER_PIXELS (40,000,000)`
(`:412-416`). Blocked exports never call the renderer.

- **Composite PNG/JPG/TIFF** (`:684-714`): full sheet dims, plate
  `"composite"`, `paper: black ? "#000000" : "#ffffff"`,
  `transparent: kind !== "jpg"` (`:697`) — so PNG/TIFF composites have
  **no paper and no matte** (alpha preserved); JPG is flattened onto
  paper (+ white matte when black). PNG passes through `withPngDpi(blob,
  240)` (`:712`); JPG/TIFF get **no DPI metadata**. TIFF
  (`encodeRgbaTiff`, `:1752-1795`) is uncompressed little-endian RGBA,
  10 IFD entries, single strip — **no ResolutionUnit/XResolution/
  YResolution tags**, i.e. the plan's "240-DPI metadata on every export
  target" is currently only true for PNG.
- **PNG plate package** (`:715-783`): per enabled plate (hidden plates are
  *excluded from the ZIP*, unlike SVG-in-renderer semantics — exclusion
  happens at `enabledPlates`, `:381-384`, `:718`), `monochromePlate: true`,
  `transparent: true` (paper argument is passed but inert, `:725`, `:733`),
  registration on each plate per the single `registration` toggle; each PNG
  gets a 240-DPI pHYs chunk (`:739`); plus `job-settings.json` embedding the
  full settings object (including custom-shape/registration SVG text).
  Zipped with JSZip (`:717`).
- **SVG plate package** (`:652-682`): per enabled plate via `renderPlateSvg`
  with full sheet dims and document; K-named file in grayscale (`:665`);
  `job-settings.json`; JSZip (`:655`).
- Download: object URL + anchor click, revoked after 1s
  (`downloadBlob`, `:1743-1750`).

`withPngDpi` (`src/studio/png-dpi.ts:75-153`): validates PNG signature,
walks chunks with truncation checks, strips any existing pHYs, inserts a
single pHYs (`round(dpi/0.0254)` px/m both axes, unit=meter) immediately
before the first IDAT, preserves bytes trailing IEND, CRC via standard
table (`png-dpi.ts:4-16`).

## 8. Custom-shape pipeline (import → stamp)

1. `checkSvgFile` — `.svg` extension, ≤1 MB, non-empty
   (`src/studio/custom-shape-data.ts:22-26`).
2. `sanitizeSvg` — full XML reconstruction, see the security review
   (`custom-shape-data.ts:114-175`).
3. `geometryBounds` — sanitized SVG imported into a *closed shadow root*
   off-screen, per-shape `getBBox` + CTM with conservative stroke/miter
   padding (`src/studio/custom-shape.ts:29-64`); rejects non-finite/empty/
   >1e9 bounds.
4. Alpha scan at 2048² (`ANALYSIS_SIZE`, `custom-shape.ts:8`, `:72-91`)
   tightens the viewBox to visible pixels; asset = `{filename,
   svg-with-tight-viewBox}` (`:92`).
5. `prepareCustomShape` re-sanitizes on every prepare (assets from
   deserialized settings are untrusted, `custom-shape.ts:102-105`;
   `parseCustomShape` also re-sanitizes, `custom-shape-data.ts:177-186`)
   and caches `{svg, image, stamps}` in a WeakMap keyed by asset object
   identity (`custom-shape.ts:6`). **Identity-keyed cache**: a
   structurally-equal but new asset object re-prepares; the new asset-store
   design (content-addressed by SHA) must re-key this cache by hash.
6. `customShapeStamp` — see §2. The prepared SVG is stretched to a square
   (`preserveAspectRatio="none"`, root 1024×1024 set by sanitizer,
   `custom-shape-data.ts:125-127`).

## 9. Settings parsing quirks the adapter must know

`parseSettings` (`src/studio/settings-schema.ts:17-92`):

- **`opacity` is validated but discarded — output always `opacity: 1`**
  (`settings-schema.ts:39`, `:75`). Saved/imported jobs never restore
  partial opacity today.
- Angles normalize to `[0, 360)` (`:60`); the renderer itself accepts any
  finite angle.
- Sparse diffusion/glitch groups are preserved as groups
  (`savedGroup`, `:88-92`): absent groups stay absent (renderer defaults
  apply), any present key pulls in the whole group with defaults.
- `cellSize` bounded `(0, 256]` in the schema (`:21`), `[3, 64]` in the UI
  (`HalftoneStudio.tsx:1150-1155`), unbounded in the renderer.
- `customShape` re-sanitized via `parseCustomShape`; `dotShape:"custom"`
  without a valid shape fails (`:46-47`).

## 10. Regression oracle and fixtures

- `tests/e2e/render-regression.spec.ts` pins the renderer sources by SHA-256
  (`:6-11`) and pixel-compares 82 cases (all dot shapes × plates, all
  diffusion algorithms × plates, registration modes × custom marks,
  grayscale/invert glitch combos on black/white paper, document mirror ×
  preview) against the frozen `tests/e2e/fixtures/renderer-3084f80/` copy,
  expecting exactly the four approved "diffusion none" divergences
  (`:70-73`). **Any new engine must be validated the same way: byte-exact
  `getImageData` equality against this baseline for the single-layer path.**
- `tests/e2e/svg-export.spec.ts` asserts raster↔SVG ink-mask agreement at
  the 0.5 threshold, white-margin preservation, custom-shape holes,
  hidden-plate full dimensions, registration alpha 0.7 layout, and the
  stamp cache surviving 12 discarded candidates.
- `tests/e2e/baseline-hashes.json` + `desktop-parity.spec.ts` /
  `design-system.spec.ts` cover UI-level output hashes.

## 11. Behaviors the compatibility adapter + regression oracle MUST preserve

Single-layer parity checklist (each item independently testable):

1. Sheet px = `round(inches·240)`, orientation swap
   (`document-model.ts:41-54`).
2. Placement: `trunc(source·scale%)`, floor-centered; no offsets
   (`document-model.ts:64-81`). Fit% clamp `[10, 400]` and `round`
   (`document-model.ts:83-94`).
3. Target-fit rounding per axis (`halftone.ts:717-739`).
4. Mirror-before-sampling, placement-rect pivot, lattice/registration not
   mirrored (`halftone.ts:768-779`).
5. Sample canvas white underpaint with document; alpha-blind sampling
   (`halftone.ts:858-874`; adapter must emulate "flatten onto white" per
   layer to preserve output while the new engine goes premultiplied).
6. Preview 1100px sampling clamp; export full-res (`halftone.ts:848-850`).
7. `renderScale` cell/stroke scaling; min cell 3 (preview/no-doc) vs 0.01
   (doc export) (`halftone.ts:671`, `:882-889`, `:992`).
8. Lattice anchored at artboard center, per-plate angle, iteration extent
   `diagonal/2 + cell`, exact rotation formula (`halftone.ts:692-695`).
9. Nearest-neighbor round-clamp sampling into the coverage field
   (`halftone.ts:698-704`).
10. `visibleContentBounds` luminance≥250 bbox clip, all-white fallback
    (`halftone.ts:311-330`, `:702-703`, `:1003-1004`).
11. `coverageFor`: 250-luminance cutoff on all plates/modes; grayscale
    round→invert→gamma-0.75; max-GCR CMYK; `0 && !invert ⇒ 0`; invert as
    coverage-space `1−v` (`halftone.ts:541-564`).
12. Glitch order and every seed constant of §4 in **sample-space
    coordinates**, channel index = C0 M1 Y2 K3 (grayscale K = 3).
13. Fray thresholds/hashes of §4; content threshold 0.1.
14. Diffusion order, serpentine mirroring, kernel tables, perturbation
    constants (0.25/0.08/0.03/0.12/0.02, reset-row formula), levels
    quantization, 0.5 presentation threshold, +0.25 px overlap (§5).
15. Dot size `cell·sqrt(coverage)·1.04`; 0.12 minimum; shape geometry incl.
    cross 0.14, line 0.32/0.16, circle-outline inner-stroke and hole-close
    (`halftone.ts:566-613`).
16. Custom stamp: square-stretch, tint via source-in, resolution
    `min(2048, max(16, ceil(2·cell·1.04)))` (`custom-shape.ts:118-137`).
17. Opacity <1 ⇒ per-plate opaque scratch canvas then single
    alpha·multiply/source-over composite (`halftone.ts:894-926`).
18. multiply for colored plates, source-over + `#111214` for
    monochrome/grayscale; grayscale composite forces monochrome
    (`halftone.ts:893`, `:498-499`, `:688-690`).
19. Paper default `#eeeae0`; black-paper (`#000000`/`#111214`,
    case-insensitive, exact-string) white matte over placement rect (doc) or
    full canvas (no doc); both suppressed by `transparent`
    (`halftone.ts:820-845`).
20. Hidden plate: raster draws nothing but keeps dimensions/registration;
    SVG emits full-dimension marks-only document; PNG ZIP *omits* the file
    (`halftone.ts:664`, `:952-953`; `HalftoneStudio.tsx:718`).
21. Registration final-pass geometry/alpha/colors of §1.12, incl. raster
    `#121416` vs SVG `#000000` stroke.
22. Export limits: 2,000,000 grid points (worst plate, rotated-bbox
    estimator), 40,000,000 diffusion plate-pixels (sheet px × enabled
    plates), 2,000,000 SVG runs; UI-level pre-gate plus in-renderer SVG
    throws (`halftone.ts:78-84`, `:509-525`, `:981`, `:995-997`;
    `HalftoneStudio.tsx:397-422`, `:633-641`).
23. PNG pHYs @240dpi insertion/stripping semantics (`png-dpi.ts:75-153`);
    TIFF exact IFD layout (`HalftoneStudio.tsx:1752-1795`).
24. SVG document: inches with 4 decimals, px viewBox, single black group
    with group opacity (`halftone.ts:1031`).
25. `parseSettings` forces opacity 1 on load; angle normalization; sparse
    group semantics (§9).

## 12. Hidden couplings that will bite the multi-layer engine

- **Alpha-blindness + white-flatten** (§1.7, §3): coverage is computed from
  RGB only after flattening onto white (doc) or nothing (no-doc). The new
  premultiplied source-alpha model changes coverage at every semi-transparent
  pixel. Parity is only achievable via an adapter that flattens the single
  layer onto white before separation.
- **`visibleContentBounds` gating** (§2): per-layer white-bbox clipping is a
  *global* function of the flattened sheet. With two layers, layer B's white
  margin must not clip layer A's dots. The knockout model must replace this
  with per-layer alpha bounds, and the oracle must confirm the single-layer
  bbox is bit-identical.
- **Background/matte entanglement** (§1.5): "background never creates ink"
  is enforced twice — white underpaint before sampling and the 250-luminance
  cutoff. `ArtboardBackground: "transparent"` has *no* current equivalent;
  naive reuse of the sampling path would turn transparent artboards into
  full-ink fields (§1.7).
- **Sample-space-seeded glitches** (§4): all glitch determinism keys off
  sample-canvas coordinates. Tiling/banding the new renderer must compute
  glitches in absolute artboard sample coordinates or tile seams and
  preview/export mismatches appear. Also preview (clamped) texture ≠ export
  texture today — pick one contract and document it.
- **Plate index as glitch channel** (§4): channelDesync/macroblock/bitmap-
  sort seeds use `PLATES.indexOf(plate)`. Layer-level glitch (plan: glitch is
  part of the layer recipe, applied before separation? — currently glitch is
  applied *per plate after separation*) is an order-of-operations change; the
  plan's "global color separation → per-layer glitch/mode kernels" wording
  inverts the current "separate then glitch each plate field" order.
  Adapter must keep per-plate-field glitching for parity.
- **Mirror semantics** (§1.8) vs `OutputDefaultsV1.pressMirror`: current
  mirror is a document/artwork setting sampled before screening; a press
  mirror at output would also mirror the lattice and registration. These are
  not interchangeable.
- **Opacity flattening** (§1.11): per-plate scratch flattening means
  intra-plate dot overlap never darkens. A per-layer opacity in the new
  compositor must flatten the *layer's plate contribution* first, then apply
  alpha once — same structure, different grouping; test with overlapping
  dots at opacity 0.5.
- **`monochromePlate` is raster-only** (§6): SVG plates are always black.
  Don't "fix" this silently; film output depends on it.
- **DOM dependence**: `renderHalftone` uses `document.createElement`
  (`halftone.ts:847`, `:895`) and custom-shape preparation uses `<img>`,
  shadow DOM and object URLs (`custom-shape.ts:14-64`) — the DOM-free worker
  kernels need `OffscreenCanvas` + `createImageBitmap` replacements, and
  custom-shape stamps must be rasterized on the main thread and transferred.
- **`drawDocumentArtwork` shadows the global `document`**
  (`halftone.ts:747`) — an easy source of worker-port bugs.
- **Registration on hidden plates** and **PNG-ZIP plate omission** disagree
  (§11.20); the new export preflight must pick per-format rules explicitly.
