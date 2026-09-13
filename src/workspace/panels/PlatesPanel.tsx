/**
 * Plates panel — CMYK vs grayscale separation, viewed plate, global plate
 * visibility, and global screen angles. Hosts the ink rail and the live
 * dot-pattern preview relocated from the former "03 Plates" stage.
 */

import { useEffect, useRef } from "react";
import { CHROME_INK } from "../../studio/inks";
import InkRail from "../../studio/InkRail";
import { PLATE_META } from "../../studio/halftone";
import type { Plate } from "../../studio/halftone";
import { useStudioApi } from "../studio-api";
import { CMYK_PRESETS } from "./cmyk-presets";

export function PlatesPanel() {
  const api = useStudioApi();
  const { settings, activePlate } = api;
  const patternPreviewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = patternPreviewRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const size = 80;
    const scale = window.devicePixelRatio || 1;
    const frayedXEdge = Number(settings.frayedXEdge ?? 0);
    const frayedYEdge = Number(settings.frayedYEdge ?? 0);
    canvas.width = size * scale;
    canvas.height = size * scale;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = "#f4f1e9";
    context.fillRect(0, 0, size, size);
    // Chrome-only preview inks: the DECLARED design-system process inks
    // (spec §3 / CHROME_INK), NOT the engine's PLATE_META render values —
    // those are render-hash-gated GPL engine colors and must not be used
    // for chrome. (Divergence is intentional; see src/studio/inks.ts.)
    const colors = [
      CHROME_INK.cyan,
      CHROME_INK.magenta,
      CHROME_INK.yellow,
      CHROME_INK.black,
    ] as const;
    const plates = ["cyan", "magenta", "yellow", "black"] as const;
    for (let plateIndex = 0; plateIndex < plates.length; plateIndex += 1) {
      const plate = plates[plateIndex];
      if (activePlate !== "composite" && plate !== activePlate) continue;
      if (!settings.visible[plate] || (settings.grayscale && plate !== "black")) continue;
      const angle = (settings.angles[plate] * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      context.fillStyle = colors[plateIndex];
      context.globalAlpha = settings.grayscale ? 0.82 : 0.48;
      const cell = Math.max(5, Math.min(14, settings.cellSize * 0.72));
      for (let u = -80; u <= 160; u += cell) {
        for (let v = -80; v <= 160; v += cell) {
          const x = 40 + u * cos - v * sin;
          const y = 40 + u * sin + v * cos;
          if (x < -4 || y < -4 || x > 84 || y > 84) continue;
          const edgeX = Math.min(x, size - x);
          const edgeY = Math.min(y, size - y);
          const fray = Math.min(
            1,
            frayedXEdge === 0 ? 1 : edgeX / (frayedXEdge * 0.8),
            frayedYEdge === 0 ? 1 : edgeY / (frayedYEdge * 0.8),
          );
          const radius = Math.max(1.5, cell * 0.32 * fray);
          context.beginPath();
          if (settings.dotShape === "square") {
            context.rect(x - radius, y - radius, radius * 2, radius * 2);
          } else if (settings.dotShape === "triangle") {
            context.moveTo(x, y - radius);
            context.lineTo(x + radius, y + radius);
            context.lineTo(x - radius, y + radius);
            context.closePath();
          } else {
            context.arc(x, y, radius, 0, Math.PI * 2);
          }
          context.fill();
        }
      }
    }
    context.globalAlpha = 1;
  }, [activePlate, settings.angles, settings.cellSize, settings.dotShape, settings.frayedXEdge, settings.frayedYEdge, settings.grayscale, settings.visible]);

  function cyclePatternPlate() {
    const sequence: Plate[] = ["composite", ...api.applicablePlates];
    const next =
      sequence[(sequence.indexOf(activePlate) + 1) % sequence.length];
    api.soloPlate(next);
  }

  function applyCmykPreset(presetId: string) {
    const preset = CMYK_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    api.setAngles({ ...preset.angles });
    api.soloPlate("composite");
    api.notify(`${preset.label} loaded`);
  }

  return (
    <div className="ws-panel-stack">
      <label className="select-field">
        <span>Color mode</span>
        <select
          value={settings.grayscale ? "grayscale" : "cmyk"}
          onChange={(event) =>
            api.updateSetting("grayscale", event.target.value === "grayscale")
          }
        >
          <option value="cmyk">CMYK</option>
          <option value="grayscale">Grayscale (K)</option>
        </select>
      </label>
      {settings.grayscale && (
        <label className="toggle-row">
          <span>
            <strong>Invert grayscale</strong>
            <small>Invert the black and white image.</small>
          </span>
          <input
            type="checkbox"
            data-testid="grayscale-invert"
            checked={settings.invert}
            onChange={(event) =>
              api.updateSetting("invert", event.target.checked)
            }
          />
        </label>
      )}
      <div className="screen-angle-box">
        <div className="halftone-cmyk-section-label">Plate angles</div>
        <span className="screen-angle-viewing" data-testid="active-plate-label">
          {activePlate === "composite"
            ? "Viewing: Composite"
            : `Viewing: ${PLATE_META[activePlate].label}`}
        </span>
        <InkRail
          activePlate={activePlate}
          settings={settings}
          onSolo={api.soloPlate}
          onToggleVisible={api.togglePlateVisible}
          onAngleChange={api.setPlateAngle}
        />
        <label className="select-field cmyk-preset-field">
          <span>CMYK presets</span>
          <select
            data-testid="cmyk-preset"
            defaultValue=""
            onChange={(event) => applyCmykPreset(event.target.value)}
          >
            <option value="" disabled>
              Select a CMYK preset
            </option>
            {CMYK_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="pattern-preview-card">
        <div>
          <strong>Dot pattern</strong>
          <small>
            {settings.diffusionEnabled
              ? "Saved halftone geometry"
              : "Live CMYK screen preview"}
          </small>
        </div>
        <button
          type="button"
          className="pattern-preview-button"
          onClick={cyclePatternPlate}
          title="Click to cycle the viewed plate"
          aria-label={`Dot pattern preview, viewing ${
            activePlate === "composite"
              ? "composite"
              : PLATE_META[activePlate].label
          }. Click to cycle plates.`}
        >
          <canvas
            ref={patternPreviewRef}
            width={80}
            height={80}
            data-testid="cmyk-pattern-preview"
            aria-label="CMYK dot pattern preview"
          />
        </button>
      </div>

      <button
        type="button"
        className="button secondary"
        onClick={api.resetHalftone}
      >
        Reset halftone / CMYK controls
      </button>
    </div>
  );
}
