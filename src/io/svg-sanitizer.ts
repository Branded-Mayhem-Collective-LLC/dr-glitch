/**
 * Strict allowlist static-SVG validator and canonical reconstructor.
 *
 * Untrusted SVG text is parsed with @xmldom/xmldom (never the live DOM), every
 * element and attribute is checked against a closed allowlist, and a brand-new
 * document is serialized from validated values only. Input bytes are never
 * echoed into the output. Anything outside the allowlist throws a typed
 * SvgValidationError with a stable code — there are no silent fallbacks.
 *
 * Three profiles share one core with per-profile limits: "artwork" (layer
 * sources), "custom-dot" (halftone dot stamps), "registration-mark".
 */
import { DOMParser, XMLSerializer, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";

export type SvgProfile = "artwork" | "custom-dot" | "registration-mark";

export type SvgProfileLimits = {
  /** Maximum source size in UTF-8 bytes. */
  maxBytes: number;
  /** Maximum element count across the whole tree. */
  maxNodes: number;
  /** Maximum element nesting depth below the root. */
  maxDepth: number;
  /**
   * Ceiling on the derived pixel area (rendered width x height in px)
   * enforced BEFORE any decode/raster/cache/export allocation. Rasterizing
   * an SVG allocates a viewport-sized surface, so this is the profile's
   * allocation budget: artwork gets the raster-pixel budget; custom dots and
   * registration marks get far smaller ones.
   */
  maxPixelArea: number;
  /**
   * Cap on the magnitude of numbers inside transform() lists. Together with
   * the pixel-area ceiling this keeps transform-driven bounds (giant
   * scale/translate factors) from turning a tiny document into pathological
   * render geometry.
   */
  maxTransformMagnitude: number;
};

export const SVG_PROFILE_LIMITS: Record<SvgProfile, SvgProfileLimits> = {
  artwork: { maxBytes: 8_000_000, maxNodes: 10_000, maxDepth: 32, maxPixelArea: 100_000_000, maxTransformMagnitude: 1_000_000 },
  "custom-dot": { maxBytes: 1_000_000, maxNodes: 2_000, maxDepth: 32, maxPixelArea: 16_777_216, maxTransformMagnitude: 10_000 },
  "registration-mark": { maxBytes: 262_144, maxNodes: 512, maxDepth: 16, maxPixelArea: 1_048_576, maxTransformMagnitude: 10_000 },
};

/** Root/viewBox dimensions this close to zero are degenerate (division-scale bombs). */
const MIN_DIMENSION_PX = 0.001;

export type SvgErrorCode =
  | "svg-empty"
  | "svg-too-large"
  | "svg-invalid-xml"
  | "svg-declaration"
  | "svg-invalid-root"
  | "svg-namespace"
  | "svg-forbidden-element"
  | "svg-forbidden-attribute"
  | "svg-event-handler"
  | "svg-external-reference"
  | "svg-url-reference"
  | "svg-text-content"
  | "svg-invalid-number"
  | "svg-invalid-viewbox"
  | "svg-missing-dimensions"
  | "svg-invalid-transform"
  | "svg-invalid-paint"
  | "svg-invalid-path"
  | "svg-invalid-attribute"
  | "svg-depth-exceeded"
  | "svg-node-limit"
  | "svg-area-exceeded"
  | "svg-no-shapes";

export class SvgValidationError extends Error {
  readonly code: SvgErrorCode;
  constructor(code: SvgErrorCode, message: string) {
    super(message);
    this.name = "SvgValidationError";
    this.code = code;
  }
}

export type SanitizedSvg = {
  /** Canonical reconstructed SVG markup; safe to persist and re-sanitize (idempotent). */
  svg: string;
  /** Rendered width/height in px derived from width/height attributes or the viewBox. */
  width: number;
  height: number;
  viewBox: [number, number, number, number];
};

const SVG_NS = "http://www.w3.org/2000/svg";
const NUMBER = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?";
const MAX_MAGNITUDE = 1e9;

/** Geometry attributes allowed per element; g carries only transform/presentation. */
const GEOMETRY: Record<string, readonly string[]> = {
  g: [],
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
};

const PRESENTATION = new Set([
  "fill", "fill-rule", "fill-opacity",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-opacity",
  "clip-rule", "opacity",
]);

/** Known-inert attributes silently dropped; they never reach the output. */
const DROPPED = new Set(["id", "class", "version", "baseProfile", "role", "xmlns", "xml:space", "xml:lang", "data-name"]);
const DROPPED_PREFIXES = ["xmlns:", "data-", "aria-", "inkscape:", "sodipodi:"];

const NONNEGATIVE = new Set(["width", "height", "r", "rx", "ry", "stroke-width"]);

/** Deterministic serialization order for canonical output stability. */
const ATTR_ORDER = [
  "d", "points", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r",
  "x1", "y1", "x2", "y2", "transform",
  "fill", "fill-rule", "fill-opacity",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-opacity",
  "clip-rule", "opacity",
];

/** CSS Color Module Level 3 keywords (plus none/transparent handled separately). */
const COLOR_KEYWORDS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
  "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
  "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
  "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink " +
  "deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold " +
  "goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush " +
  "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey " +
  "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
  "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
  "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
  "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
  "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));

function fail(code: SvgErrorCode, message: string): never {
  throw new SvgValidationError(code, message);
}

function parseNumbers(value: string, code: SvgErrorCode, what: string): number[] {
  const pattern = new RegExp(NUMBER, "g");
  const tokens = value.match(pattern) ?? [];
  if (value.replace(pattern, "").replace(/[\s,]/g, "")) fail(code, `Invalid ${what}.`);
  const result = tokens.map(Number);
  if (result.some((n) => !Number.isFinite(n) || Math.abs(n) > MAX_MAGNITUDE)) {
    fail("svg-invalid-number", `Nonfinite or oversized number in ${what}.`);
  }
  return result;
}

/** Absolute length to px; percentages, calc(), and relative units are rejected. */
function lengthPx(value: string, name: string): number {
  const match = value.trim().match(new RegExp(`^(${NUMBER})(px|pt|pc|mm|cm|in)?$`));
  if (!match) fail("svg-invalid-attribute", `Unsupported ${name} value; use absolute SVG units.`);
  const factors: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  const result = Number(match[1]) * (factors[match[2]] ?? 1);
  if (!Number.isFinite(result) || Math.abs(result) > MAX_MAGNITUDE) fail("svg-invalid-number", `Nonfinite ${name}.`);
  if (NONNEGATIVE.has(name) && result < 0) fail("svg-invalid-attribute", `Negative ${name}.`);
  return result;
}

function pathData(value: string): string {
  const pattern = new RegExp(`[a-df-zA-DF-Z]|${NUMBER}`, "g");
  const tokens = value.match(pattern) ?? [];
  if (value.replace(pattern, "").replace(/[\s,]/g, "")) fail("svg-invalid-path", "Invalid path data.");
  const counts: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  if (tokens[0]?.toUpperCase() !== "M") fail("svg-invalid-path", "Path data must begin with a move command.");
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++].toUpperCase();
    const count = counts[command];
    if (count === undefined) fail("svg-invalid-path", "Unknown path command.");
    const args: number[] = [];
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) {
      args.push(...parseNumbers(tokens[i++], "svg-invalid-path", "path data"));
    }
    if (count === 0 ? args.length !== 0 : args.length === 0 || args.length % count !== 0) {
      fail("svg-invalid-path", "Incomplete path command.");
    }
    if (command === "A") {
      for (let a = 0; a < args.length; a += 7) {
        if (args[a] < 0 || args[a + 1] < 0 || ![0, 1].includes(args[a + 3]) || ![0, 1].includes(args[a + 4])) {
          fail("svg-invalid-path", "Invalid arc parameters.");
        }
      }
    }
  }
  return value.trim();
}

function transform(value: string, maxMagnitude: number): string {
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  const matches = [...value.matchAll(pattern)];
  if (!matches.length || value.replace(pattern, "").replace(/[\s,]/g, "")) {
    fail("svg-invalid-transform", "Unsupported transform; only matrix/translate/scale/rotate/skewX/skewY.");
  }
  const arity: Record<string, number[]> = {
    matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1],
  };
  return matches.map((match) => {
    const args = parseNumbers(match[2], "svg-invalid-transform", "transform");
    if (!arity[match[1]].includes(args.length)) fail("svg-invalid-transform", `Invalid ${match[1]}() arguments.`);
    // Profile-scaled magnitude cap: pathological scale/translate factors are
    // rejected before any consumer derives bounds or allocates from them.
    if (args.some((n) => Math.abs(n) > maxMagnitude)) {
      fail("svg-invalid-transform", `Transform values above ${maxMagnitude} are rejected for this profile.`);
    }
    return `${match[1]}(${args.join(" ")})`;
  }).join(" ");
}

function channel(raw: string, what: string): number {
  const percent = raw.endsWith("%");
  const n = Number(percent ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) fail("svg-invalid-paint", `Invalid ${what}.`);
  return Math.max(0, Math.min(255, Math.round(percent ? n * 2.55 : n)));
}

/** Solid paints only: keywords, #hex, rgb()/rgba(). Everything else is rejected. */
function paint(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent") return "none";
  if (COLOR_KEYWORDS.has(v)) return v;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return v;
  const rgb = v.match(new RegExp(`^rgba?\\(\\s*(${NUMBER}%?)\\s*[,\\s]\\s*(${NUMBER}%?)\\s*[,\\s]\\s*(${NUMBER}%?)\\s*(?:[,/]\\s*(${NUMBER}%?)\\s*)?\\)$`));
  if (rgb) {
    const [r, g, b] = [channel(rgb[1], "red"), channel(rgb[2], "green"), channel(rgb[3], "blue")];
    if (rgb[4] === undefined) return `rgb(${r},${g},${b})`;
    const alphaRaw = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    if (!Number.isFinite(alphaRaw)) fail("svg-invalid-paint", "Invalid alpha.");
    const alpha = Math.max(0, Math.min(1, alphaRaw));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  fail("svg-invalid-paint", "Unsupported paint; use solid color keywords, #hex, or rgb().");
}

function opacityValue(value: string, name: string): string {
  const n = Number(value.trim());
  if (!value.trim() || !Number.isFinite(n) || n < 0 || n > 1) fail("svg-invalid-attribute", `Invalid ${name}.`);
  return String(n);
}

const ENUMS: Record<string, readonly string[]> = {
  "fill-rule": ["nonzero", "evenodd"],
  "clip-rule": ["nonzero", "evenodd"],
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
};

function attributeValue(name: string, value: string, limits: SvgProfileLimits): string {
  if (/url\s*\(/i.test(value)) fail("svg-url-reference", `url() reference in ${name} is unsupported.`);
  if (/javascript:|data:/i.test(value)) fail("svg-external-reference", `External or data reference in ${name} is unsupported.`);
  if (/[<>]/.test(value)) fail("svg-invalid-attribute", `Invalid characters in ${name}.`);
  if (name === "d") return pathData(value);
  if (name === "transform") return transform(value, limits.maxTransformMagnitude);
  if (name === "fill" || name === "stroke") return paint(value);
  if (name === "points") {
    const list = parseNumbers(value, "svg-invalid-attribute", "points");
    if (!list.length || list.length % 2) fail("svg-invalid-attribute", "Invalid points list.");
    return list.join(" ");
  }
  if (name === "stroke-dasharray") {
    if (value.trim() === "none") return "none";
    const list = parseNumbers(value, "svg-invalid-attribute", "stroke-dasharray");
    if (!list.length || list.some((n) => n < 0)) fail("svg-invalid-attribute", "Invalid stroke-dasharray.");
    return list.join(" ");
  }
  if (name === "stroke-miterlimit") {
    const n = Number(value.trim());
    if (!Number.isFinite(n) || n < 1 || n > 100) fail("svg-invalid-attribute", "Invalid stroke-miterlimit.");
    return String(n);
  }
  if (name === "opacity" || name === "fill-opacity" || name === "stroke-opacity") return opacityValue(value, name);
  if (ENUMS[name]) {
    const v = value.trim();
    if (!ENUMS[name].includes(v)) fail("svg-invalid-attribute", `Unsupported ${name} value.`);
    return v;
  }
  return String(lengthPx(value, name));
}

function isDropped(name: string): boolean {
  return DROPPED.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function checkAttributeName(name: string, tag: string): "allowed" | "dropped" {
  if (/^on/i.test(name)) fail("svg-event-handler", `Event attribute ${name} is forbidden.`);
  if (name === "href" || name.endsWith(":href")) fail("svg-external-reference", `${name} references are forbidden.`);
  if (name === "style") fail("svg-forbidden-attribute", "CSS styling (style attribute) is forbidden; use presentation attributes.");
  if (isDropped(name)) return "dropped";
  const geometry = GEOMETRY[tag];
  if (geometry && (geometry.includes(name) || PRESENTATION.has(name) || name === "transform")) return "allowed";
  fail("svg-forbidden-attribute", `Attribute ${name} on <${tag}> is unsupported.`);
}

/**
 * Validate untrusted SVG text and return a canonical reconstruction.
 * Throws SvgValidationError; never returns partially sanitized output.
 */
export function sanitizeSvg(source: string, profile: SvgProfile): SanitizedSvg {
  const limits = SVG_PROFILE_LIMITS[profile];
  if (!source.trim()) fail("svg-empty", "The SVG is empty.");
  if (source.length > limits.maxBytes || new TextEncoder().encode(source).length > limits.maxBytes) {
    fail("svg-too-large", `The SVG exceeds ${limits.maxBytes} bytes for the ${profile} profile.`);
  }
  // Refuse declarations before parsing so entity expansion can never start.
  if (/<!DOCTYPE/i.test(source)) fail("svg-declaration", "DOCTYPE declarations are forbidden.");
  if (/<!ENTITY/i.test(source)) fail("svg-declaration", "Entity declarations are forbidden.");
  if (/<\?(?!xml[\s?])/i.test(source)) fail("svg-declaration", "Processing instructions are forbidden.");

  let parsed;
  try {
    parsed = new DOMParser({ onError: () => { throw new Error("invalid xml"); } })
      .parseFromString(source, "image/svg+xml");
  } catch {
    fail("svg-invalid-xml", "The file is not well-formed XML.");
  }
  const input = parsed.documentElement;
  if (!input || input.localName !== "svg") fail("svg-invalid-root", "The root element must be <svg>.");
  if (input.namespaceURI && input.namespaceURI !== SVG_NS) fail("svg-namespace", "The root element is not in the SVG namespace.");

  // Root sizing: viewBox preferred, else width/height, else reject.
  let viewBox: [number, number, number, number] | null = null;
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  for (let i = 0; i < input.attributes.length; i++) {
    const attr = input.attributes.item(i)!;
    const name = attr.name;
    if (/^on/i.test(name)) fail("svg-event-handler", `Event attribute ${name} is forbidden.`);
    if (name === "href" || name.endsWith(":href")) fail("svg-external-reference", `${name} references are forbidden.`);
    if (name === "style") fail("svg-forbidden-attribute", "CSS styling (style attribute) is forbidden.");
    if (name === "viewBox") {
      const box = parseNumbers(attr.value, "svg-invalid-viewbox", "viewBox");
      if (box.length !== 4 || box[2] <= 0 || box[3] <= 0) fail("svg-invalid-viewbox", "The viewBox must be four numbers with positive size.");
      viewBox = [box[0], box[1], box[2], box[3]];
      continue;
    }
    if (name === "width") { widthPx = lengthPx(attr.value, "width"); continue; }
    if (name === "height") { heightPx = lengthPx(attr.value, "height"); continue; }
    if (name === "preserveAspectRatio" || isDropped(name)) continue;
    fail("svg-forbidden-attribute", `Attribute ${name} on the SVG root is unsupported.`);
  }
  if (widthPx !== null && widthPx <= 0) fail("svg-invalid-attribute", "The SVG width must be positive.");
  if (heightPx !== null && heightPx <= 0) fail("svg-invalid-attribute", "The SVG height must be positive.");
  if (!viewBox) {
    if (widthPx === null || heightPx === null) fail("svg-missing-dimensions", "The SVG needs a viewBox or width and height.");
    viewBox = [0, 0, widthPx, heightPx];
  }
  const width = widthPx ?? viewBox[2];
  const height = heightPx ?? viewBox[3];
  // Resource bounds BEFORE any consumer allocates from these dimensions:
  // finite positive is guaranteed above (parseNumbers/lengthPx reject
  // NaN/Infinity/oversized); near-zero degenerates and the derived
  // pixel-area budget are enforced here, profile-scaled.
  if (viewBox[2] < MIN_DIMENSION_PX || viewBox[3] < MIN_DIMENSION_PX) {
    fail("svg-invalid-viewbox", "The viewBox size is too close to zero.");
  }
  if (width < MIN_DIMENSION_PX || height < MIN_DIMENSION_PX) {
    fail("svg-invalid-attribute", "The SVG dimensions are too close to zero.");
  }
  if (width * height > limits.maxPixelArea) {
    fail("svg-area-exceeded", `The SVG covers ${width * height} px², over the ${limits.maxPixelArea} px² budget for the ${profile} profile.`);
  }

  const output = parsed.implementation.createDocument(SVG_NS, "svg", null);
  const root = output.documentElement!;
  root.setAttribute("viewBox", viewBox.join(" "));
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));

  let nodes = 0;
  let shapes = 0;

  function copyChildren(from: XmlElement, into: XmlElement, depth: number) {
    for (let i = 0; i < from.childNodes.length; i++) {
      const child: XmlNode = from.childNodes.item(i)!;
      if (child.nodeType === 8) continue; // comments dropped
      if (child.nodeType === 7) fail("svg-declaration", "Processing instructions are forbidden.");
      if (child.nodeType === 3 || child.nodeType === 4) {
        if (child.nodeValue?.trim()) fail("svg-text-content", "Text content is forbidden; convert text to paths.");
        continue;
      }
      if (child.nodeType !== 1) fail("svg-invalid-xml", "Unsupported XML node.");
      const element = child as XmlElement;
      const tag = element.localName ?? "";
      if (tag === "title" || tag === "desc") continue; // dropped with their children
      if (element.namespaceURI && element.namespaceURI !== SVG_NS) {
        fail("svg-namespace", `Element <${tag}> is outside the SVG namespace.`);
      }
      if (!Object.hasOwn(GEOMETRY, tag)) {
        fail("svg-forbidden-element", tag === "text" || tag === "tspan"
          ? "SVG text is forbidden; convert it to paths."
          : `Element <${tag}> is forbidden.`);
      }
      if (++nodes > limits.maxNodes) fail("svg-node-limit", `The SVG exceeds ${limits.maxNodes} elements.`);
      if (depth + 1 > limits.maxDepth) fail("svg-depth-exceeded", `The SVG nests deeper than ${limits.maxDepth} levels.`);
      const target = output.createElementNS(SVG_NS, tag);
      const values = new Map<string, string>();
      for (let a = 0; a < element.attributes.length; a++) {
        const attr = element.attributes.item(a)!;
        if (checkAttributeName(attr.name, tag) === "dropped") continue;
        values.set(attr.name, attributeValue(attr.name, attr.value, limits));
      }
      for (const name of ATTR_ORDER) {
        const value = values.get(name);
        if (value !== undefined) target.setAttribute(name, value);
      }
      into.appendChild(target);
      if (tag !== "g") shapes++;
      copyChildren(element, target, depth + 1);
    }
  }

  copyChildren(input as unknown as XmlElement, root, 0);
  if (!shapes) fail("svg-no-shapes", "The SVG contains no vector shapes.");
  return {
    svg: new XMLSerializer().serializeToString(root),
    width,
    height,
    viewBox,
  };
}
