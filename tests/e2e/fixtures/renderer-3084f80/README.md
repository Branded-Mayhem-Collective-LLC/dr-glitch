# Immutable renderer reference

These four files are byte-for-byte Git blobs from
`3084f80686d3d326fcedc05dded2b35a70bf4c37:src/studio/`, the release task's starting
GitHub main commit. Do not update them to make a regression pass.

`render-regression.spec.ts` verifies SHA256 checksums and compares the current
renderer with this reference using identical source pixels in the same browser.
This avoids font/platform/PNG-encoder drift in the historical hash files, which
remain as historical artifacts. The fixture is not in the production bundle.
