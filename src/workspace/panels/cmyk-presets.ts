/** Canonical CMYK screen-angle presets offered in the Plates panel. */

export const CMYK_PRESETS = [
  {
    id: "preset-1",
    label: "Preset 1 · C15 M75 Y0 K45",
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  },
  {
    id: "preset-2",
    label: "Preset 2 · C105 M75 Y90 K15",
    angles: { cyan: 105, magenta: 75, yellow: 90, black: 15 },
  },
  {
    id: "preset-3",
    label: "Preset 3 · C15 M45 Y0 K75",
    angles: { cyan: 15, magenta: 45, yellow: 0, black: 75 },
  },
  {
    id: "preset-4",
    label: "Preset 4 · C165 M45 Y90 K105",
    angles: { cyan: 165, magenta: 45, yellow: 90, black: 105 },
  },
] as const;
