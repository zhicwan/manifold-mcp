/**
 * String-distance helpers and human-friendly "did you mean" messaging used
 * by the static lint. Kept separate from `static-lint.ts` so the AST walk
 * doesn't get tangled up with general-purpose suggestion logic, and so a
 * future explainDiagnostic surface can reuse `levenshtein`/`suggestMany`
 * without pulling in the whole static analyser.
 */

const API_ALIASES = new Map<string, string>([
  ['Manifold.box', 'Use Manifold.cube(size, center).'],
  ['CrossSection.ofPolygon', 'Use CrossSection.ofPolygons([points]) for one contour.'],
  [
    'CrossSection.roundedRectangle',
    "No roundedRectangle helper exists; use CrossSection.square([w - 2*r, h - 2*r], true).offset(r, 'Round', 2, segments).",
  ],
]);

/** Look up an alias hint (e.g. "Manifold.box" -> "Use Manifold.cube(...)."). */
export function aliasFor(namespace: string, name: string): string | undefined {
  return API_ALIASES.get(`${namespace}.${name}`);
}

/** Whether we have a curated alias hint for the given namespaced symbol. */
export function hasAlias(namespace: string, name: string): boolean {
  return API_ALIASES.has(`${namespace}.${name}`);
}

/**
 * Return up to `limit` candidate names from `pool` that are within edit
 * distance `max(2, ceil(name.length / 2))` of `name`, sorted by
 * (distance asc, candidate localeCompare asc).
 */
export function suggestMany(name: string, pool: Set<string>, limit = 3): string[] {
  const scored: Array<{ candidate: string; distance: number }> = [];
  const maxDistance = Math.max(2, Math.ceil(name.length / 2));
  for (const candidate of pool) {
    const d = levenshtein(name, candidate);
    if (d <= maxDistance) {
      scored.push({ candidate, distance: d });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map(item => item.candidate);
}

/**
 * Build the canonical UNKNOWN_API message. Prefers a hand-curated alias
 * hint; otherwise falls back to a Levenshtein-based "did you mean" list,
 * and finally a generic pointer at the API reference.
 */
export function unknownApiMessage(namespace: 'Manifold' | 'CrossSection', name: string, pool: Set<string>): string {
  const alias = aliasFor(namespace, name);
  if (alias) {
    return `${namespace}.${name} is not a known static method. ${alias}`;
  }
  const nearest = suggestMany(name, pool);
  if (nearest.length > 0) {
    return `${namespace}.${name} is not a known static method. Did you mean ${nearest.join(' or ')}?`;
  }
  return `${namespace}.${name} is not a known static method. Check the ${namespace} API reference for supported factory methods.`;
}

/** Standard iterative two-row Levenshtein distance. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) {
    row[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j - 1], row[j]);
      prev = tmp;
    }
  }
  return row[n];
}
