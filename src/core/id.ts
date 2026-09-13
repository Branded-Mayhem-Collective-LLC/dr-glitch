/** Generate an opaque unique id for layers, projects, snapshots, presets. */
export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Non-secure fallback for environments without crypto.randomUUID.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
