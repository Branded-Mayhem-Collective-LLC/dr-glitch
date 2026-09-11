import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";

export type CustomShapeAsset = { filename: string; svg: string };
export const MAX_SVG_BYTES = 1_000_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const NUMBER = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?";
const geometry: Record<string, string[]> = {
  path: ["d"], rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"],
  polygon: ["points"], polyline: ["points"], line: ["x1", "y1", "x2", "y2"], g: [],
};
const presentation = new Set([
  "fill", "stroke", "fill-rule", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "fill-opacity",
  "stroke-opacity", "display", "visibility",
]);
const ignored = new Set(["id", "class", "version", "xmlns", "xmlns:xlink", "xml:space", "data-name"]);
const nonnegative = new Set(["width", "height", "r", "rx", "ry", "stroke-width"]);

function invalid(message: string): never { throw new Error(message); }

export function checkSvgFile(filename: string, size: number) {
  if (!/\.svg$/i.test(filename)) invalid("Choose an .svg file.");
  if (size > MAX_SVG_BYTES) invalid("Choose an SVG smaller than 1 MB.");
  if (size === 0) invalid("This SVG is empty. Choose a file with visible vector shapes.");
}

function numbers(value: string): number[] {
  const tokens = value.match(new RegExp(NUMBER, "g")) ?? [];
  if (value.replace(new RegExp(NUMBER, "g"), "").replace(/[\s,]/g, "")) invalid("The SVG contains invalid coordinates.");
  const result = tokens.map(Number);
  if (result.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9)) invalid("The SVG coordinates are too large or invalid.");
  return result;
}

function length(value: string, name: string): string {
  const match = value.trim().match(new RegExp(`^(${NUMBER})(px|pt|pc|mm|cm|in)?$`));
  if (!match) invalid(`Unsupported ${name} value. Use absolute SVG units instead of percentages or expressions.`);
  const factors: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  const result = Number(match[1]) * (factors[match[2]] ?? 1);
  if (!Number.isFinite(result) || Math.abs(result) > 1e9 || (nonnegative.has(name) && result < 0)) invalid(`Invalid ${name} in SVG.`);
  return String(result);
}

function pathData(value: string): string {
  const tokens = value.match(new RegExp(`[a-df-zA-DF-Z]|${NUMBER}`, "g")) ?? [];
  if (value.replace(new RegExp(`[a-df-zA-DF-Z]|${NUMBER}`, "g"), "").replace(/[\s,]/g, "")) invalid("The SVG contains an invalid vector path.");
  const counts: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  if (tokens[0]?.toUpperCase() !== "M") invalid("Each SVG path must begin with a move command.");
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++].toUpperCase();
    const count = counts[command];
    if (count === undefined) invalid("The SVG contains an invalid vector path command.");
    const args: number[] = [];
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) args.push(...numbers(tokens[i++]));
    if (count === 0 ? args.length !== 0 : args.length === 0 || args.length % count !== 0) invalid("The SVG contains an incomplete vector path.");
    if (command === "A") {
      for (let a = 0; a < args.length; a += 7) {
        if (args[a] < 0 || args[a + 1] < 0 || ![0, 1].includes(args[a + 3]) || ![0, 1].includes(args[a + 4])) invalid("The SVG contains an invalid arc.");
      }
    }
  }
  return value.trim();
}

function attribute(name: string, value: string): string {
  if (/url\s*\(|[<>]|!important/i.test(value)) invalid("SVG references and external resources are unsupported. Expand the shape to paths first.");
  if (name === "d") return pathData(value);
  if (name === "transform") {
    const matches = [...value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)];
    if (!matches.length || value.replace(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, "").replace(/[\s,]/g, "")) invalid("Unsupported SVG transform.");
    return matches.map((match) => {
      const args = numbers(match[2]);
      const allowed: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
      if (!allowed[match[1]].includes(args.length)) invalid("Invalid SVG transform.");
      return `${match[1]}(${args.join(" ")})`;
    }).join(" ");
  }
  if (name === "fill" || name === "stroke") {
    if (value === "none" || value === "transparent") return "none";
    if (value === "inherit") return value;
    if (!/^(#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%+\-/]+\))$/i.test(value)) invalid("Unsupported SVG paint. Use solid fills and strokes.");
    return "#000000";
  }
  if (name === "points" || name === "stroke-dasharray") {
    if (name === "stroke-dasharray" && value === "none") return value;
    const list = numbers(value);
    if (!list.length || (name === "points" && list.length % 2) || (name === "stroke-dasharray" && list.some((n) => n < 0))) invalid(`Invalid ${name} in SVG.`);
    return list.join(" ");
  }
  const enums: Record<string, string[]> = {
    "fill-rule": ["nonzero", "evenodd"], "stroke-linecap": ["butt", "round", "square"],
    "stroke-linejoin": ["miter", "round", "bevel"], display: ["none", "inline"],
    visibility: ["visible", "hidden", "collapse"],
  };
  if (enums[name]) {
    if (!enums[name].includes(value)) invalid(`Unsupported SVG ${name}.`);
    return value;
  }
  if (name.includes("opacity")) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1 || !value.trim()) invalid("Invalid SVG opacity.");
    return String(n);
  }
  if (name === "stroke-miterlimit") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 100) invalid("Unsupported SVG miter limit.");
    return String(n);
  }
  return length(value, name);
}

/** XML-only reconstruction; input nodes are never inserted into the live DOM. */
export function sanitizeSvg(source: string): string {
  if (source.length > MAX_SVG_BYTES || new TextEncoder().encode(source).length > MAX_SVG_BYTES) invalid("Choose an SVG smaller than 1 MB.");
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) invalid("SVG document declarations and external resources are unsupported.");
  let parsed;
  try {
    parsed = new DOMParser({ onError: () => { throw new Error("Invalid XML"); } }).parseFromString(source, "image/svg+xml");
  } catch { invalid("This file is not a valid SVG. Re-export it as plain SVG and try again."); }
  const input = parsed.documentElement;
  if (!input || input.localName !== "svg" || (input.namespaceURI && input.namespaceURI !== SVG_NS)) invalid("Choose a valid SVG file.");
  const output = parsed.implementation.createDocument(SVG_NS, "svg", null);
  const root = output.documentElement!;
  root.setAttribute("width", "1024");
  root.setAttribute("height", "1024");
  root.setAttribute("preserveAspectRatio", "none");
  const box = input.getAttribute("viewBox");
  const bounds = box ? numbers(box) : [0, 0, 1024, 1024];
  if (bounds.length !== 4 || bounds[2] <= 0 || bounds[3] <= 0) invalid("The SVG has an invalid viewBox.");
  root.setAttribute("viewBox", bounds.join(" "));
  let count = 0;
  let shapes = 0;
  function copy(node: XmlElement, parent: XmlElement, depth: number, isRoot = false) {
    if (++count > 2000 || depth > 32) invalid("This SVG is too complex for a repeated dot. Simplify it first.");
    const tag = node.localName ?? "";
    if (["title", "desc", "metadata"].includes(tag)) return;
    if (tag === "defs") return;
    if (!isRoot && (!Object.hasOwn(geometry, tag) || (node.namespaceURI && node.namespaceURI !== SVG_NS))) {
      invalid(tag === "text" ? "Convert SVG text to paths before importing." : `SVG ${tag} is unsupported. Expand the artwork to plain paths first.`);
    }
    const target = output.createElementNS(SVG_NS, isRoot ? "g" : tag);
    const attributes = new Map<string, string>();
    let styles = "";
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      const name = attr.name;
      if (name === "style") { styles = attr.value; continue; }
      if (ignored.has(name) || name.startsWith("xmlns:") || name.startsWith("data-") || name.startsWith("aria-") || name.startsWith("inkscape:") || name.startsWith("sodipodi:")) continue;
      if (isRoot && ["viewBox", "width", "height", "preserveAspectRatio", "x", "y"].includes(name)) continue;
      if (!presentation.has(name) && name !== "transform" && !(geometry[tag] ?? []).includes(name)) invalid(`SVG ${name} is unsupported. Use plain paths with inline fills and strokes.`);
      attributes.set(name, attr.value.trim());
    }
    for (const declaration of styles.split(";")) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(":");
      const name = declaration.slice(0, colon).trim();
      if (colon < 0 || !presentation.has(name)) invalid("Unsupported SVG styling. Export plain paths with inline fills and strokes.");
      attributes.set(name, declaration.slice(colon + 1).trim());
    }
    for (const [name, value] of attributes) target.setAttribute(name, attribute(name, value));
    if (!isRoot && tag !== "g") shapes++;
    const destination = isRoot && attributes.size === 0 ? parent : target;
    if (destination === target) parent.appendChild(target);
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i)!;
      if (child.nodeType === 1) copy(child as XmlElement, destination, depth + 1);
      else if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue?.trim()) invalid("Convert SVG text to paths before importing.");
      else if (child.nodeType === 7) invalid("SVG processing instructions are unsupported.");
    }
  }
  copy(input, root, 0, true);
  if (!shapes) invalid("This SVG has no vector shapes.");
  return new XMLSerializer().serializeToString(root);
}

export function parseCustomShape(input: unknown): CustomShapeAsset | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.filename !== "string" || raw.filename.length > 255 || typeof raw.svg !== "string") return null;
  try {
    checkSvgFile(raw.filename, new TextEncoder().encode(raw.svg).length);
    // Serialized settings are untrusted too; preserve only reconstructed SVG.
    return { filename: raw.filename, svg: sanitizeSvg(raw.svg) };
  } catch { return null; }
}
