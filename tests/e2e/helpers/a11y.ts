import { expect, type Locator } from "@playwright/test";

/** WCAG relative-luminance contrast ratio between two rgb() strings. */
export function contrastRatio(foreground: string, background: string): number {
  function luminance(color: string) {
    const channels = color
      .match(/\d+(?:\.\d+)?/g)!
      .slice(0, 3)
      .map((channel) => Number(channel) / 255)
      .map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Asserts the element is focused and paints a visible focus indicator
 * (outline at least 2px, matching the existing studio focus idiom).
 */
export async function expectVisibleFocus(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const outline = await locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      style: styles.outlineStyle,
      width: Number.parseFloat(styles.outlineWidth),
    };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
}

/** Asserts a control's hit target meets a minimum square size in CSS px. */
export async function expectMinTarget(
  locator: Locator,
  minimum: number,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

/**
 * Asserts every CSS transition on the element resolves to zero duration —
 * the reduced-motion contract for workspace chrome.
 */
export async function expectZeroTransitionDurations(
  locator: Locator,
): Promise<void> {
  const durations = await locator.evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(",")
      .map((value) => Number.parseFloat(value.trim())),
  );
  for (const duration of durations) {
    expect(duration).toBe(0);
  }
}
