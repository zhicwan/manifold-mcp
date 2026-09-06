import { describe, expect, it } from 'vitest';

import {
  runStaticStage,
  MAX_CODE_BYTES,
  detectResultAssignmentInJs,
} from '../packages/modeling/src/validation/validators.js';
import { ERROR_STATUS_TO_CODE } from '../packages/modeling/src/validation/report.js';

describe('runStaticStage — forbidden globals', () => {
  it.each([
    ['process', 'process.exit(0); result = Manifold.cube();'],
    ['require', 'const x = require("fs"); result = Manifold.cube();'],
    ['eval', 'eval("1+1"); result = Manifold.cube();'],
    ['Function', 'const f = new Function("return 1"); result = Manifold.cube();'],
    ['AsyncFunction', 'declare const AsyncFunction: unknown; void AsyncFunction; result = Manifold.cube();'],
    ['globalThis', 'globalThis.x = 1; result = Manifold.cube();'],
    ['global', 'declare const global: unknown; void global; result = Manifold.cube();'],
    ['module', 'declare const module: unknown; void module; result = Manifold.cube();'],
    ['child_process', 'const cp = child_process; result = Manifold.cube();'],
    ['fs', 'const f = fs; result = Manifold.cube();'],
    ['__dirname', 'const d = __dirname; result = Manifold.cube();'],
    ['__filename', 'const f = __filename; result = Manifold.cube();'],
    ['SharedArrayBuffer', 'const memory = new SharedArrayBuffer(8); result = Manifold.cube(memory.byteLength);'],
  ])('flags %s as FORBIDDEN_GLOBAL', (_name, code) => {
    const r = runStaticStage(code);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'FORBIDDEN_GLOBAL')).toBe(true);
  });

  it.each([
    ['dynamic import', `void import('node:fs'); result = Manifold.cube();`],
    ['import.meta', `const url = import.meta.url; result = Manifold.cube(url.length);`],
    ['direct constructor access', `const ctor = ({}).constructor; result = Manifold.cube();`],
    ['computed constructor access', `const ctor = ({})['constructor']; result = Manifold.cube();`],
    ['reflective constructor access', `const ctor = Reflect.get({}, 'constructor'); result = Manifold.cube();`],
    ['Reflect.construct', `Reflect.construct(Object, []); result = Manifold.cube();`],
  ])('flags %s as forbidden dynamic code', (_name, code) => {
    const r = runStaticStage(code);
    expect(r.ok).toBe(false);
    expect(r.errors.some(error => error.code === 'FORBIDDEN_GLOBAL' && error.category === 'sandbox')).toBe(true);
  });
});

describe('runStaticStage — MAX_CODE_BYTES boundary', () => {
  // Build a snippet of an exact byte length. The boundary is exclusive:
  // strictly greater than MAX_CODE_BYTES triggers CODE_TOO_LARGE.
  const buildSnippet = (totalBytes: number): string => {
    const tail = 'result = Manifold.cube();';
    const tailLen = Buffer.byteLength(tail, 'utf8');
    // 4 bytes for '/*' + '*/' comment wrappers.
    const padLen = totalBytes - tailLen - 4;
    if (padLen < 0) {
      throw new Error('totalBytes too small');
    }
    return '/*' + 'x'.repeat(padLen) + '*/' + tail;
  };

  it('one byte over MAX_CODE_BYTES triggers CODE_TOO_LARGE', () => {
    const code = buildSnippet(MAX_CODE_BYTES + 1);
    expect(Buffer.byteLength(code, 'utf8')).toBe(MAX_CODE_BYTES + 1);
    const r = runStaticStage(code);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'CODE_TOO_LARGE')).toBe(true);
  });

  it('exactly MAX_CODE_BYTES does not trigger CODE_TOO_LARGE', () => {
    const code = buildSnippet(MAX_CODE_BYTES);
    expect(Buffer.byteLength(code, 'utf8')).toBe(MAX_CODE_BYTES);
    const r = runStaticStage(code);
    expect(r.errors.some(e => e.code === 'CODE_TOO_LARGE')).toBe(false);
  });
});

describe('runStaticStage — RESULT_NOT_ASSIGNED', () => {
  it('triggers when no result assignment is present', () => {
    const r = runStaticStage('const x = Manifold.cube();');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(true);
  });

  it('does not trigger for `result = Manifold.cube()`', () => {
    const r = runStaticStage('result = Manifold.cube();');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(false);
  });

  it('does not trigger for `let result = Manifold.cube()`', () => {
    const r = runStaticStage('let result = Manifold.cube();');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(false);
  });

  it('does not trigger for `const result = Manifold.cube()`', () => {
    const r = runStaticStage('const result = Manifold.cube();');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(false);
  });

  it('does not trigger for `[result] = …` array destructuring', () => {
    const r = runStaticStage('let result; [result] = [Manifold.cube()];');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(false);
  });

  it('does not trigger for `({ result } = …)` shorthand destructuring', () => {
    const r = runStaticStage('let result; ({ result } = { result: Manifold.cube() });');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(false);
  });

  it('does not trigger for `result ??=` compound assignment', () => {
    const r = runStaticStage('let result; result ??= Manifold.cube();');
    expect(r.errors.some(e => e.code === 'RESULT_NOT_ASSIGNED')).toBe(false);
  });
});

describe('detectResultAssignmentInJs', () => {
  it('detects plain `result =` in emitted JS', () => {
    expect(detectResultAssignmentInJs('result = 1;')).toBe(true);
  });

  it('detects `let result = …`', () => {
    expect(detectResultAssignmentInJs('let result = 1;')).toBe(true);
  });

  it('detects `[result] =` array destructuring', () => {
    expect(detectResultAssignmentInJs('let result; [result] = [1];')).toBe(true);
  });

  it('detects `({ result } = …)` shorthand destructuring', () => {
    expect(detectResultAssignmentInJs('let result; ({ result } = { result: 1 });')).toBe(true);
  });

  it('detects `({ x: result } = …)` aliased destructuring', () => {
    expect(detectResultAssignmentInJs('let result; ({ x: result } = { x: 1 });')).toBe(true);
  });

  it('detects compound assigns (??= ||= &&=)', () => {
    expect(detectResultAssignmentInJs('let result; result ??= 1;')).toBe(true);
    expect(detectResultAssignmentInJs('let result; result ||= 1;')).toBe(true);
    expect(detectResultAssignmentInJs('let result; result &&= 1;')).toBe(true);
  });

  it('returns false when nothing assigns to `result`', () => {
    expect(detectResultAssignmentInJs('const x = 1; foo(x);')).toBe(false);
  });

  it('returns false when only a different variable is assigned', () => {
    expect(detectResultAssignmentInJs('const noResult = 1;')).toBe(false);
  });
});

describe('ERROR_STATUS_TO_CODE mapping', () => {
  it('maps every key to a non-empty string code', () => {
    const keys = Object.keys(ERROR_STATUS_TO_CODE);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const code = ERROR_STATUS_TO_CODE[key];
      expect(typeof code).toBe('string');
      expect(code && code.length > 0).toBe(true);
    }
  });
});

describe('looksLikeRadians (heuristic, exercised via runStaticStage warnings)', () => {
  // The heuristic isn't exported directly. We exercise it via the
  // RADIANS_DETECTED warning surface.
  it('does not throw on integer rotate arg', () => {
    expect(() => runStaticStage('result = Manifold.cube().rotate([0, 0, 90]);')).not.toThrow();
  });

  it('does not throw on Math.PI rotate arg', () => {
    expect(() => runStaticStage('result = Manifold.cube().rotate([0, 0, Math.PI]);')).not.toThrow();
  });

  it('does not throw on empty arg list', () => {
    expect(() => runStaticStage('result = Manifold.cube().rotate();')).not.toThrow();
  });

  it('does not flag rotate(1.5) (sub-2π non-integer literal)', () => {
    const r = runStaticStage('result = Manifold.cube().rotate(1.5);');
    expect(r.warnings.some(w => w.code === 'RADIANS_DETECTED')).toBe(false);
  });

  it('does not flag rotate([0, 0, 0.25])', () => {
    const r = runStaticStage('result = Manifold.cube().rotate([0, 0, 0.25]);');
    expect(r.warnings.some(w => w.code === 'RADIANS_DETECTED')).toBe(false);
  });

  it('does not flag rotate(0.5) (the documented false-positive)', () => {
    const r = runStaticStage('result = Manifold.cube().rotate(0.5);');
    expect(r.warnings.some(w => w.code === 'RADIANS_DETECTED')).toBe(false);
  });

  it('flags rotate(Math.PI / 2)', () => {
    const r = runStaticStage('result = Manifold.cube().rotate(Math.PI / 2);');
    expect(r.warnings.some(w => w.code === 'RADIANS_DETECTED')).toBe(true);
  });

  it('flags rotate([0, 0, Math.PI])', () => {
    const r = runStaticStage('result = Manifold.cube().rotate([0, 0, Math.PI]);');
    expect(r.warnings.some(w => w.code === 'RADIANS_DETECTED')).toBe(true);
  });

  it('flags rotate(rad) when an identifier named rad is passed', () => {
    const r = runStaticStage('const rad = 1.0; result = Manifold.cube().rotate(rad);');
    expect(r.warnings.some(w => w.code === 'RADIANS_DETECTED')).toBe(true);
  });
});

describe('UNKNOWN_API (post-VAL-1: alias-only emission)', () => {
  it('emits UNKNOWN_API for aliased Manifold.box', () => {
    const r = runStaticStage('result = Manifold.box([1, 1, 1]);');
    expect(r.warnings.some(w => w.code === 'UNKNOWN_API')).toBe(true);
  });

  it('emits UNKNOWN_API for aliased CrossSection.roundedRectangle', () => {
    const r = runStaticStage('result = CrossSection.roundedRectangle([20, 10], 2).extrude(5);');
    expect(r.warnings.some(w => w.code === 'UNKNOWN_API')).toBe(true);
  });

  it('does NOT emit UNKNOWN_API for arbitrary unknown names (typecheck owns those)', () => {
    const r = runStaticStage('result = Manifold.totallyMadeUp([1, 1, 1]);');
    expect(r.warnings.some(w => w.code === 'UNKNOWN_API')).toBe(false);
  });
});
