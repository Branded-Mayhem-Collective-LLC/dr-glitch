/**
 * Export session state + shared target construction (wave F items:
 * selected-layer PNG/TIFF persisted in the export session; the Output
 * drawer readiness and the Export panel agree on the ACTIVE target).
 */
import { describe, expect, it } from "vitest";
import { createExportSessionStore } from "../../src/export/export-session";
import { buildTargetFromSession } from "../../src/workspace/export-target";

describe("ExportSessionStore.layerFormat", () => {
  it("defaults to png and persists the choice across target switches", () => {
    const store = createExportSessionStore();
    expect(store.getState().layerFormat).toBe("png");
    store.setLayerFormat("tiff");
    expect(store.getState().layerFormat).toBe("tiff");
    store.setTargetKind("composite");
    store.setTargetKind("selected-layer");
    expect(store.getState().layerFormat).toBe("tiff");
  });

  it("notifies subscribers", () => {
    const store = createExportSessionStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.setLayerFormat("tiff");
    expect(calls).toBe(1);
  });
});

describe("buildTargetFromSession", () => {
  const context = { selectedLayerId: "layer-1", vectorEligible: true };

  it("builds the composite target from the session formats", () => {
    const store = createExportSessionStore();
    store.setTargetKind("composite");
    store.setCompositeFormat("tiff");
    expect(buildTargetFromSession(store.getState(), context)).toEqual({
      kind: "composite",
      format: "tiff",
    });
  });

  it("builds the plate target, falling back to png when vector is ineligible", () => {
    const store = createExportSessionStore();
    store.setPlateFormat("svg");
    expect(buildTargetFromSession(store.getState(), context)).toEqual({
      kind: "plate-package",
      format: "svg",
    });
    expect(
      buildTargetFromSession(store.getState(), { ...context, vectorEligible: false }),
    ).toEqual({ kind: "plate-package", format: "png" });
  });

  it("builds the selected-layer target with the persisted format and registration", () => {
    const store = createExportSessionStore();
    store.setTargetKind("selected-layer");
    store.setLayerFormat("tiff");
    store.setLayerRegistration(true);
    expect(buildTargetFromSession(store.getState(), context)).toEqual({
      kind: "selected-layer",
      format: "tiff",
      layerId: "layer-1",
      registration: true,
    });
  });

  it("returns null for selected-layer with no layers", () => {
    const store = createExportSessionStore();
    store.setTargetKind("selected-layer");
    expect(
      buildTargetFromSession(store.getState(), {
        selectedLayerId: null,
        vectorEligible: true,
      }),
    ).toBeNull();
  });

  it("honors an explicit kind override without mutating the store", () => {
    const store = createExportSessionStore();
    expect(
      buildTargetFromSession(store.getState(), context, "composite"),
    ).toEqual({ kind: "composite", format: "png" });
    expect(store.getState().targetKind).toBe("plate-package");
  });
});
