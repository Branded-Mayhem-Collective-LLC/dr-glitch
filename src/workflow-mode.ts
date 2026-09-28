// The superseded workstation is source-review-only, never a production option.
export const WORKSTATION_REVIEW =
  import.meta.env.DEV && import.meta.env.VITE_DRG_WORKSTATION_REVIEW === "1";
