import { describe, expect, it } from "vitest";
import { HELP_CATEGORY_LABELS, HELP_TOPICS, getHelpTopic } from "../../src/help/content";
import { searchHelp } from "../../src/help/search";
import { TOOL_DEFINITIONS } from "../../src/core/tool-registry";

describe("help content", () => {
  it("has real, complete topics — no placeholders", () => {
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(10);
    for (const topic of HELP_TOPICS) {
      expect(topic.id).toMatch(/^[a-z0-9-]+$/);
      expect(topic.title.trim().length).toBeGreaterThan(0);
      expect(topic.body.trim().length).toBeGreaterThan(80);
      expect(topic.keywords.length).toBeGreaterThan(0);
      expect(Object.keys(HELP_CATEGORY_LABELS)).toContain(topic.category);
      expect(topic.body.toLowerCase()).not.toContain("lorem");
      expect(topic.body.toLowerCase()).not.toContain("todo");
    }
  });

  it("has unique topic ids", () => {
    const ids = HELP_TOPICS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every category", () => {
    const categories = new Set(HELP_TOPICS.map(({ category }) => category));
    expect(categories).toEqual(new Set(["shortcuts", "gestures", "tools", "production"]));
  });

  it("lists every registered tool shortcut from the tool registry", () => {
    const shortcuts = getHelpTopic("shortcuts-tools");
    expect(shortcuts).toBeDefined();
    for (const tool of TOOL_DEFINITIONS) {
      expect(shortcuts!.body).toContain(tool.label);
      if (tool.shortcut) {
        expect(shortcuts!.body).toContain(`${tool.shortcut.toUpperCase()} — ${tool.label}`);
      }
    }
  });

  it("documents each current tool's effects", () => {
    for (const id of ["tool-halftone", "tool-diffusion", "tool-glitch", "tool-layers", "tool-plates"]) {
      expect(getHelpTopic(id), id).toBeDefined();
    }
    expect(getHelpTopic("tool-diffusion")!.body).toContain("Floyd-Steinberg");
    expect(getHelpTopic("tool-diffusion")!.body).toContain("Atkinson");
    expect(getHelpTopic("tool-halftone")!.body).toContain("45°");
  });

  it("documents production consequences", () => {
    for (const id of [
      "production-registration",
      "production-polarity",
      "production-press-mirror",
      "production-angles-moire",
      "production-vector-plates",
    ]) {
      expect(getHelpTopic(id), id).toBeDefined();
    }
  });
});

describe("help search relevance", () => {
  it("returns everything in content order for an empty query", () => {
    const results = searchHelp(HELP_TOPICS, "   ");
    expect(results.map(({ topic }) => topic.id)).toEqual(HELP_TOPICS.map(({ id }) => id));
  });

  it("ranks moiré guidance first for 'moire'", () => {
    const results = searchHelp(HELP_TOPICS, "moire");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].topic.id).toBe("production-angles-moire");
  });

  it("finds diffusion by algorithm name", () => {
    const results = searchHelp(HELP_TOPICS, "floyd steinberg");
    expect(results[0].topic.id).toBe("tool-diffusion");
  });

  it("ranks title matches above body-only matches", () => {
    const results = searchHelp(HELP_TOPICS, "registration marks");
    expect(results[0].topic.id).toBe("production-registration");
  });

  it("surfaces shortcut topics for 'shortcuts'", () => {
    const results = searchHelp(HELP_TOPICS, "shortcuts");
    expect(results.slice(0, 3).every(({ topic }) => topic.category === "shortcuts")).toBe(true);
  });

  it("returns nothing for nonsense", () => {
    expect(searchHelp(HELP_TOPICS, "xyzzy-quux-42")).toEqual([]);
  });

  it("orders results by descending score", () => {
    const results = searchHelp(HELP_TOPICS, "plate registration press");
    const scores = results.map(({ score }) => score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
