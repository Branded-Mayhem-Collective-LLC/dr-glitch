import { describe, expect, it } from "vitest";
import { sanitizeSvg, SvgValidationError, SVG_PROFILE_LIMITS } from "../../src/io/svg-sanitizer";

const VALID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(10, 10)"><path d="M0 0 L50 0 L50 50 Z" fill="#FF0000"/><rect x="1" y="2" width="10" height="10" rx="2" stroke="black" stroke-width="1.5"/><circle cx="5" cy="5" r="4" fill="rgb(0, 128, 255)" fill-opacity="0.5"/><ellipse cx="9" cy="9" rx="3" ry="2"/><line x1="0" y1="0" x2="9" y2="9" stroke="teal"/><polyline points="0,0 4,4 8,0" fill="none" stroke="green"/><polygon points="0 0 6 0 3 6" fill-rule="evenodd"/></g></svg>`;

function rejects(source: string, code: string, profile: "artwork" | "custom-dot" | "registration-mark" = "artwork") {
  try {
    sanitizeSvg(source, profile);
  } catch (error) {
    expect(error).toBeInstanceOf(SvgValidationError);
    expect((error as SvgValidationError).code).toBe(code);
    return error as SvgValidationError;
  }
  throw new Error(`expected rejection ${code} for: ${source.slice(0, 120)}`);
}

const wrap = (body: string, rootAttrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${rootAttrs}><rect width="1" height="1"/>${body}</svg>`;

describe("svg-sanitizer accepts safe static SVG", () => {
  it("accepts all allowlisted shapes, groups, transforms, and paints", () => {
    const result = sanitizeSvg(VALID, "artwork");
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(result.svg).toContain("<path");
    expect(result.svg).toContain('transform="translate(10 10)"');
    expect(result.svg).toContain('fill="rgb(0,128,255)"');
  });

  it("is canonical and stable: sanitizing the output reproduces it exactly", () => {
    const once = sanitizeSvg(VALID, "artwork");
    const twice = sanitizeSvg(once.svg, "artwork");
    expect(twice.svg).toBe(once.svg);
    for (const profile of ["custom-dot", "registration-mark"] as const) {
      expect(sanitizeSvg(once.svg, profile).svg).toBe(once.svg);
    }
  });

  it("derives the viewBox from width/height when absent", () => {
    const result = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="96px"><rect width="10" height="10"/></svg>', "artwork");
    expect(result.viewBox).toEqual([0, 0, 192, 96]);
    expect(result.width).toBe(192);
  });

  it("drops title/desc and inert attributes without echoing them", () => {
    const result = sanitizeSvg(wrap('<title>hi &amp; bye</title><desc>d</desc><rect id="EVIL" class="stylable" data-x="1" width="2" height="2"/>'), "artwork");
    expect(result.svg).not.toMatch(/title|desc|EVIL|class|data-x/);
  });

  it("keeps color keywords and normalizes hex and rgb()", () => {
    const result = sanitizeSvg(wrap('<rect width="1" height="1" fill="RebeccaPurple" stroke="#ABCDEF"/>'), "artwork");
    expect(result.svg).toContain('fill="rebeccapurple"');
    expect(result.svg).toContain('stroke="#abcdef"');
  });
});

describe("svg-sanitizer rejects every forbidden vector", () => {
  it("rejects DOCTYPE, entities, and processing instructions", () => {
    rejects(`<!DOCTYPE svg [<!ENTITY x "y">]>${VALID}`, "svg-declaration");
    rejects(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://x/svg11.dtd">${VALID}`, "svg-declaration");
    rejects(`<?xml-stylesheet href="evil.css"?>${VALID}`, "svg-declaration");
  });

  it("rejects script and style", () => {
    rejects(wrap("<script>alert(1)</script>"), "svg-forbidden-element");
    rejects(wrap("<style>rect{fill:red}</style>"), "svg-forbidden-element");
    rejects(wrap('<rect width="1" height="1" style="fill:red"/>'), "svg-forbidden-attribute");
  });

  it("rejects external and embedded content elements", () => {
    for (const body of [
      '<use href="#x"/>',
      '<image href="https://evil.example/x.png" width="1" height="1"/>',
      "<text>hi</text>",
      "<tspan>hi</tspan>",
      '<font-face font-family="x"/>',
      '<filter id="f"/>',
      '<mask id="m"/>',
      '<clipPath id="c"/>',
      '<pattern id="p"/>',
      '<marker id="k"/>',
      '<symbol id="s"/>',
      "<defs></defs>",
      '<foreignObject width="1" height="1"><div/></foreignObject>',
      "<switch/>",
      "<metadata>x</metadata>",
      "<unknownElement/>",
    ]) rejects(wrap(body), "svg-forbidden-element");
  });

  it("rejects every animation element", () => {
    for (const body of [
      '<animate attributeName="x" from="0" to="1"/>',
      '<set attributeName="x" to="1"/>',
      '<animateTransform attributeName="transform"/>',
      '<animateMotion path="M0 0"/>',
    ]) rejects(wrap(body), "svg-forbidden-element");
  });

  it("rejects event handler attributes anywhere", () => {
    rejects(wrap('<rect width="1" height="1" onclick="alert(1)"/>'), "svg-event-handler");
    rejects(wrap('<rect width="1" height="1" onload="x()"/>'), "svg-event-handler");
    rejects(wrap("", ' onload="x()"'), "svg-event-handler");
  });

  it("rejects url() paints and references", () => {
    rejects(wrap('<rect width="1" height="1" fill="url(#grad)"/>'), "svg-url-reference");
    rejects(wrap('<rect width="1" height="1" fill="url(https://evil.example)"/>'), "svg-url-reference");
  });

  it("rejects href, xlink:href, and data: URIs", () => {
    rejects(wrap('<path d="M0 0" href="data:text/html,x"/>'), "svg-external-reference");
    rejects('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><path d="M0 0" xlink:href="#x"/></svg>', "svg-external-reference");
  });

  it("rejects foreign namespaces and unknown attributes", () => {
    rejects('<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>', "svg-namespace");
    rejects(wrap('<rect width="1" height="1" filter="blur(5px)"/>'), "svg-forbidden-attribute");
    rejects(wrap('<rect width="1" height="1" clip-path="circle()"/>'), "svg-forbidden-attribute");
  });

  it("rejects text content and CDATA", () => {
    rejects(wrap("<g>loose text</g>"), "svg-text-content");
    rejects(wrap("<g><![CDATA[alert(1)]]></g>"), "svg-text-content");
  });

  it("rejects nonfinite and oversized numbers", () => {
    rejects(wrap('<rect width="1e999" height="1"/>'), "svg-invalid-number");
    rejects(wrap('<circle cx="0" cy="0" r="9999999999"/>'), "svg-invalid-number");
    rejects(wrap('<g transform="scale(1e400)"/>'), "svg-invalid-number");
    rejects(wrap('<rect width="NaN" height="1"/>'), "svg-invalid-attribute");
  });

  it("rejects invalid transforms, paths, and paints", () => {
    rejects(wrap('<g transform="perspective(4)"/>'), "svg-invalid-transform");
    rejects(wrap('<path d="Q 1 2"/>'), "svg-invalid-path");
    rejects(wrap('<rect width="1" height="1" fill="expression(alert(1))"/>'), "svg-invalid-paint");
    rejects(wrap('<rect width="1" height="1" fill="notacolorname"/>'), "svg-invalid-paint");
  });

  it("rejects missing dimensions and invalid viewBox", () => {
    rejects('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', "svg-missing-dimensions");
    rejects('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 -5 5"><rect width="1" height="1"/></svg>', "svg-invalid-viewbox");
    rejects('<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="10"><rect width="1" height="1"/></svg>', "svg-invalid-attribute");
  });

  it("rejects empty, shapeless, and malformed documents", () => {
    rejects("", "svg-empty");
    rejects("   ", "svg-empty");
    rejects('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g/></svg>', "svg-no-shapes");
    rejects("<svg", "svg-invalid-xml");
    rejects("<div>not svg</div>", "svg-invalid-root");
  });

  it("rejects trees that are too deep or too large per profile", () => {
    const deep = `${"<g>".repeat(40)}<rect width="1" height="1"/>${"</g>".repeat(40)}`;
    rejects(wrap(deep), "svg-depth-exceeded");
    const wide = '<rect width="1" height="1"/>'.repeat(SVG_PROFILE_LIMITS["registration-mark"].maxNodes + 1);
    rejects(wrap(wide), "svg-node-limit", "registration-mark");
  });

  it("enforces per-profile byte budgets", () => {
    const padded = wrap(`<rect width="1" height="1"/><!--${"a".repeat(SVG_PROFILE_LIMITS["registration-mark"].maxBytes)}-->`);
    rejects(padded, "svg-too-large", "registration-mark");
    expect(SVG_PROFILE_LIMITS.artwork.maxBytes).toBeGreaterThan(SVG_PROFILE_LIMITS["custom-dot"].maxBytes);
  });

  it("never echoes rejected constructs into any successful output", () => {
    const smuggle = wrap('<rect width="1" height="1" aria-label="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/>');
    const result = sanitizeSvg(smuggle, "artwork");
    expect(result.svg).not.toMatch(/script|aria-label/);
  });
});

describe("svg-sanitizer resource bounds (profile-scaled, pre-allocation)", () => {
  const svgOf = (attrs: string, shape = '<rect width="1" height="1"/>') =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${shape}</svg>`;

  it("enforces a derived pixel-area ceiling per profile BEFORE any allocation", () => {
    // 400 MP viewport: over every profile budget.
    rejects(svgOf('viewBox="0 0 20000 20000"'), "svg-area-exceeded", "artwork");
    // 64 MP: fine for artwork (100 MP), over custom-dot (16.7 MP) and registration (1 MP).
    const midsize = svgOf('viewBox="0 0 8000 8000"');
    expect(sanitizeSvg(midsize, "artwork").width).toBe(8000);
    rejects(midsize, "svg-area-exceeded", "custom-dot");
    rejects(midsize, "svg-area-exceeded", "registration-mark");
    // 4 MP: fine for custom-dot, over registration.
    const small = svgOf('viewBox="0 0 2000 2000"');
    expect(sanitizeSvg(small, "custom-dot").height).toBe(2000);
    rejects(small, "svg-area-exceeded", "registration-mark");
    // The ceilings match the published limits table exactly.
    expect(SVG_PROFILE_LIMITS.artwork.maxPixelArea).toBe(100_000_000);
    expect(SVG_PROFILE_LIMITS["custom-dot"].maxPixelArea).toBe(16_777_216);
    expect(SVG_PROFILE_LIMITS["registration-mark"].maxPixelArea).toBe(1_048_576);
  });

  it("rejects near-zero, NaN, and Infinity dimensions typed", () => {
    rejects(svgOf('viewBox="0 0 1e-9 5"'), "svg-invalid-viewbox");
    rejects(svgOf('viewBox="0 0 5 0.00001"'), "svg-invalid-viewbox");
    rejects(svgOf('viewBox="0 0 10 10" width="1e-9" height="5"'), "svg-invalid-attribute");
    rejects(svgOf('width="NaN" height="5"'), "svg-invalid-attribute");
    rejects(svgOf('width="Infinity" height="5"'), "svg-invalid-attribute");
    rejects(svgOf('viewBox="0 0 1e300 5"'), "svg-invalid-number");
  });

  it("rejects transform-driven pathological bounds per profile, typed, before allocation", () => {
    const withTransform = (t: string) => wrap(`<g transform="${t}"><rect width="1" height="1"/></g>`);
    // Over the custom-dot/registration cap (1e4), under the artwork cap (1e6).
    const scale = withTransform("scale(100000)");
    expect(sanitizeSvg(scale, "artwork").svg).toContain("scale(100000)");
    rejects(scale, "svg-invalid-transform", "custom-dot");
    rejects(scale, "svg-invalid-transform", "registration-mark");
    // Over every profile cap.
    rejects(withTransform("translate(2000000 0)"), "svg-invalid-transform", "artwork");
    rejects(withTransform("matrix(1 0 0 1 9999999 0)"), "svg-invalid-transform", "artwork");
  });

  it("valid canonical output near the budgets stays a fixed point", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 4000"><g transform="scale(2) rotate(45)"><rect width="10" height="10"/></g></svg>`;
    const once = sanitizeSvg(source, "custom-dot");
    expect(sanitizeSvg(once.svg, "custom-dot").svg).toBe(once.svg);
  });
});
