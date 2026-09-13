/** Canvas backing plus readback are bounded independently of sheet height. */
export const REGISTRATION_PAINT_ROWS = 32;
export const REGISTRATION_STAMP_MAX_EDGE = 2048;

export function customRegistrationPeakBytes(width: number): number {
  // One 2048² stamp, SVG decode/text allowance, canvas band and readback.
  return 24 * 1024 * 1024 + width * REGISTRATION_PAINT_ROWS * 8;
}
