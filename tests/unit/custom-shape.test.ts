import { describe, expect, it } from "vitest";
import { checkSvgFile, parseCustomShape, sanitizeSvg } from "../../src/studio/custom-shape-data";
import { parseSettings } from "../../src/studio/settings-schema";

const svg = (body: string, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ${extra}>${body}</svg>`;
const valid = svg('<path fill-rule="evenodd" d="M10 10H90V90H10Z M30 30V70H70V30Z"/>');
const settings = {
  cellSize: 12, frayedXEdge: 0, frayedYEdge: 0, opacity: 1, dotShape: "custom", invert: false,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
};

describe("custom SVG data", () => {
  it("keeps paths and holes but removes their original paint colors", () => {
    const result = sanitizeSvg(svg('<path fill="#ff0000" fill-rule="evenodd" d="M0 0L40 0L0 80Z"/>'));
    expect(result).toContain('fill="#000000"');
    expect(result).toContain('fill-rule="evenodd"');
    expect(result).toContain('preserveAspectRatio="none"');
    expect(result).not.toContain("#ff0000");
  });
  it("preserves groups, transforms, inline strokes, opacity, and absolute units", () => {
    const result = sanitizeSvg(svg('<g transform="translate(2, 3) rotate(30)" stroke="blue"><rect width="1in" height="20pt" style="fill:none;stroke-width:2;stroke-linejoin:round;stroke-opacity:0.5"/></g>'));
    expect(result).toContain('transform="translate(2 3) rotate(30)"');
    expect(result).toContain('width="96"');
    expect(result).toContain('fill="none"');
    expect(result).toContain('stroke-opacity="0.5"');
  });
  it("ignores unused SVG definitions while retaining visible geometry", () => {
    const result = sanitizeSvg(svg('<defs><linearGradient id="unused"><stop offset="0"/></linearGradient></defs><path d="M0 0H50V50Z"/>'));
    expect(result).toContain("<path");
    expect(result).not.toContain("linearGradient");
  });
  it("accepts class attributes commonly emitted by vector editors", () => {
    const result = sanitizeSvg(svg('<path class="st0 shape-primary" d="M0 0H50V50Z"/>'));
    expect(result).toContain("<path");
    expect(result).not.toContain("class=");
  });
  it("round-trips normalized SVG without growing groups", () => {
    const normalized = sanitizeSvg(valid);
    expect(sanitizeSvg(normalized)).toBe(normalized);
    expect(parseCustomShape({ filename: "ring.svg", svg: normalized })).toEqual({ filename: "ring.svg", svg: normalized });
  });
  it.each([
    '<script>alert(1)</script>', '<image href="https://example.com/a.png"/>',
    '<foreignObject><div>Hi</div></foreignObject>', '<text>Hi</text>', '<use href="#shape"/>',
    '<mask/>', '<filter/>', '<animate attributeName="r"/>', '<style>path{fill:red}</style>',
    '<path onload="alert(1)" d="M0 0L10 0L10 10Z"/>',
    '<path style="fill:url(https://example.com/x)" d="M0 0L10 0L10 10Z"/>',
    '<path clip-path="url(#clip)" d="M0 0L10 0L10 10Z"/>',
  ])("rejects unsupported or active content: %s", (body) => {
    expect(() => sanitizeSvg(svg(body))).toThrow();
  });
  it.each(["", "not an SVG", "<svg><path></svg>", "<html/>", '<!DOCTYPE svg SYSTEM "https://example.com/dtd"><svg/>'])
    ("rejects malformed XML: %s", (input) => expect(() => sanitizeSvg(input)).toThrow());
  it.each(["M0 0L", "M0 0 L1", "M0 0X2 3", "M0 0A5 5 0 2 0 10 10", "L1 2", "M0 0L1e999 2"])
    ("rejects invalid path data: %s", (d) => expect(() => sanitizeSvg(svg(`<path d="${d}"/>`))).toThrow());
  it.each([
    '<path d="M0 0C1 2 3 4 5 6S7 8 9 10Q11 12 13 14T15 16A2 3 0 0 1 20 20z"/>',
    '<circle cx="4" cy="5" r="3"/><ellipse cx="8" cy="9" rx="2" ry="4"/>',
    '<polygon points="0,0 10,0 5,10"/><polyline points="0 0 4 8"/><line x1="1" x2="4" y1="2" y2="9" stroke="black"/>',
  ])("accepts supported geometry: %s", (body) => expect(() => sanitizeSvg(svg(body))).not.toThrow());
  it("rejects unsupported units, invalid bounds, and excessive complexity", () => {
    expect(() => sanitizeSvg(svg('<rect width="20%" height="3"/>'))).toThrow(/absolute/);
    expect(() => sanitizeSvg('<svg viewBox="0 0 0 10"><rect width="2" height="3"/></svg>')).toThrow(/viewBox/);
    expect(() => sanitizeSvg(svg('<g>'.repeat(33) + '<circle r="1"/>' + '</g>'.repeat(33)))).toThrow(/complex/);
  });
  it("enforces file type and byte limit", () => {
    expect(() => checkSvgFile("shape.png", 10)).toThrow(/\.svg/);
    expect(() => checkSvgFile("shape.svg", 1_000_001)).toThrow(/1 MB/);
    expect(() => checkSvgFile("shape.SVG", 10)).not.toThrow();
    expect(() => checkSvgFile("shape.svg", 0)).toThrow(/empty/);
  });
  it("requires valid shape data only when custom is selected", () => {
    expect(parseSettings(settings)).toEqual({ ok: false, field: "customShape" });
    expect(parseSettings({ ...settings, customShape: { filename: "bad.svg", svg: "<script/>" } })).toEqual({ ok: false, field: "customShape" });
    const result = parseSettings({ ...settings, customShape: { filename: "ring.svg", svg: valid } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.customShape?.svg).toContain('fill-rule="evenodd"');
    expect(parseSettings({ ...settings, dotShape: "round" }).ok).toBe(true);
  });
});
