/**
 * VAL-7 drift test: the static-lint whitelists in validators.ts must
 * stay in sync with the ambient TypeScript declarations exposed to user
 * snippets. If Phase 4 (ambient surface) gains/loses a `static foo(...)`
 * declaration, the lint must follow.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { sandboxAmbientDeclarations } from '../packages/modeling/src/sandbox/ambient-types.js';
import { KNOWN_MANIFOLD_STATIC, KNOWN_CROSSSECTION_STATIC } from '../packages/modeling/src/validation/validators.js';

function extractStaticMethodNames(className: string): Set<string> {
  const sf = ts.createSourceFile('ambients.ts', sandboxAmbientDeclarations, ts.ScriptTarget.ES2022, true);
  const out = new Set<string>();
  ts.forEachChild(sf, node => {
    if (!ts.isClassDeclaration(node)) {
      return;
    }
    if (!node.name || node.name.text !== className) {
      return;
    }
    for (const member of node.members) {
      const isStatic =
        ts.canHaveModifiers(member) &&
        (ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false);
      if (!isStatic) {
        continue;
      }
      if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && ts.isIdentifier(member.name)) {
        out.add(member.name.text);
      }
    }
  });
  return out;
}

describe('lint static-method whitelist vs sandbox ambient declarations', () => {
  it('Manifold lint whitelist matches the ambient class statics', () => {
    const ambient = extractStaticMethodNames('Manifold');
    const lint = new Set(KNOWN_MANIFOLD_STATIC);

    const missingFromLint = [...ambient].filter(name => !lint.has(name)).sort();
    const extraInLint = [...lint].filter(name => !ambient.has(name)).sort();

    expect({ missingFromLint, extraInLint }).toEqual({
      missingFromLint: [],
      extraInLint: [],
    });
  });

  it('CrossSection lint whitelist matches the ambient class statics', () => {
    const ambient = extractStaticMethodNames('CrossSection');
    const lint = new Set(KNOWN_CROSSSECTION_STATIC);

    const missingFromLint = [...ambient].filter(name => !lint.has(name)).sort();
    const extraInLint = [...lint].filter(name => !ambient.has(name)).sort();

    expect({ missingFromLint, extraInLint }).toEqual({
      missingFromLint: [],
      extraInLint: [],
    });
  });
});
