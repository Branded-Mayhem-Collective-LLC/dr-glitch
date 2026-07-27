import { describe, expect, it } from "vitest";
import { parseSettings } from "../../src/studio/settings-schema";

const valid = {
  cellSize: 12,
  contrast: 1,
  exposure: 0,
  opacity: 0.84,
  dotShape: "round",
  invert: false,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
};

describe("parseSettings", () => {
  it("accepts a valid settings object", () => {
    const result = parseSettings(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cellSize).toBe(12);
  });

  it("rejects a zero cellSize, which would divide by zero", () => {
    const result = parseSettings({ ...valid, cellSize: 0 });
    expect(result).toEqual({ ok: false, field: "cellSize" });
  });

  it("rejects a negative cellSize", () => {
    expect(parseSettings({ ...valid, cellSize: -3 })).toEqual({ ok: false, field: "cellSize" });
  });

  it("rejects an unknown dot shape", () => {
    expect(parseSettings({ ...valid, dotShape: "hexagon" })).toEqual({ ok: false, field: "dotShape" });
  });

  it("rejects a missing plate angle", () => {
    const { black: _drop, ...partial } = valid.angles;
    expect(parseSettings({ ...valid, angles: partial })).toEqual({ ok: false, field: "angles.black" });
  });

  it("rejects non-object input", () => {
    expect(parseSettings(null)).toEqual({ ok: false, field: "settings" });
    expect(parseSettings("nope")).toEqual({ ok: false, field: "settings" });
  });

  it("clamps opacity into 0..1 rather than rejecting", () => {
    const result = parseSettings({ ...valid, opacity: 4 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.opacity).toBe(1);
  });

  it("normalizes angles into 0..360", () => {
    const result = parseSettings({ ...valid, angles: { ...valid.angles, cyan: 375 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.angles.cyan).toBe(15);
  });
});
