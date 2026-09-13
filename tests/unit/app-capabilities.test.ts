/**
 * Environment capability probe: pure feature detection over an injected
 * scope, plus the preflight/port projections.
 */
import { describe, expect, it } from "vitest";
import {
  preflightCapabilitiesFrom,
  previewPortKindFor,
  probeEnvironmentCapabilities,
} from "../../src/app/capabilities";

const FULL_SCOPE = {
  Worker: function Worker() {},
  OffscreenCanvas: function OffscreenCanvas() {},
  createImageBitmap: () => Promise.resolve({}),
  showSaveFilePicker: () => Promise.resolve({}),
};

describe("probeEnvironmentCapabilities", () => {
  it("detects every capability on a fully equipped scope", () => {
    expect(probeEnvironmentCapabilities(FULL_SCOPE)).toEqual({
      moduleWorkers: true,
      offscreenCanvas: true,
      createImageBitmap: true,
      fileSystemAccess: true,
    });
  });

  it("reports everything false on an empty scope", () => {
    expect(probeEnvironmentCapabilities({})).toEqual({
      moduleWorkers: false,
      offscreenCanvas: false,
      createImageBitmap: false,
      fileSystemAccess: false,
    });
  });

  it("detects partial environments independently (Firefox-like)", () => {
    const env = probeEnvironmentCapabilities({
      Worker: function Worker() {},
      OffscreenCanvas: function OffscreenCanvas() {},
      createImageBitmap: () => Promise.resolve({}),
      // no showSaveFilePicker
    });
    expect(env.moduleWorkers).toBe(true);
    expect(env.offscreenCanvas).toBe(true);
    expect(env.fileSystemAccess).toBe(false);
  });

  it("never throws on odd scope values", () => {
    expect(() =>
      probeEnvironmentCapabilities({ Worker: 42, OffscreenCanvas: null } as Record<
        string,
        unknown
      >),
    ).not.toThrow();
    const env = probeEnvironmentCapabilities({ Worker: 42 } as Record<string, unknown>);
    expect(env.moduleWorkers).toBe(false);
  });

  it("defaults to globalThis (node: no workers-as-DOM, no canvas)", () => {
    const env = probeEnvironmentCapabilities();
    // Node 22+ exposes Worker (web worker shim) in some builds; assert only
    // the DOM-specific negatives that hold in the vitest node environment.
    expect(env.offscreenCanvas).toBe(false);
    expect(env.fileSystemAccess).toBe(false);
  });
});

describe("projections", () => {
  it("maps the probe onto preflight capabilities", () => {
    expect(preflightCapabilitiesFrom(probeEnvironmentCapabilities(FULL_SCOPE))).toEqual({
      offscreenCanvas: true,
      fileSystemAccess: true,
    });
    expect(preflightCapabilitiesFrom(probeEnvironmentCapabilities({}))).toEqual({
      offscreenCanvas: false,
      fileSystemAccess: false,
    });
  });

  it("selects the preview port kind from module worker support", () => {
    expect(previewPortKindFor(probeEnvironmentCapabilities(FULL_SCOPE))).toBe("worker");
    expect(previewPortKindFor(probeEnvironmentCapabilities({}))).toBe("main-thread");
  });
});
