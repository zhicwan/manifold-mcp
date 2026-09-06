import { describe, expect, it } from 'vitest';

import {
  addError,
  addHint,
  addWarning,
  emptyReport,
  reportToYaml,
} from '../packages/modeling/src/validation/report.js';

describe('reportToYaml', () => {
  it('serializes an OK report', () => {
    const r = emptyReport('runtime');
    r.ok = true;
    r.stage = 'ok';
    expect(reportToYaml(r)).toMatchInlineSnapshot(`
      "ok: true
      stage: ok
      errors: []
      warnings: []
      hints: []
      "
    `);
  });

  it('serializes a report with one error, one warning, one hint', () => {
    const r = emptyReport('runtime');
    addError(r, {
      stage: 'runtime',
      code: 'RUNTIME_ERROR',
      message: 'boom',
      line: 3,
      col: 1,
      snippet: "throw new Error('boom');",
    });
    addWarning(r, {
      stage: 'static',
      code: 'UNKNOWN_API',
      message: 'Manifold.box is not known.',
      line: 1,
      col: 18,
    });
    addHint(r, 'consider lowering circular segments');
    expect(reportToYaml(r)).toMatchInlineSnapshot(`
      "ok: false
      stage: runtime
      errors:
        - stage: runtime
          code: RUNTIME_ERROR
          message: boom
          line: 3
          col: 1
          snippet: throw new Error('boom');
          category: runtime
      warnings:
        - stage: static
          code: UNKNOWN_API
          message: Manifold.box is not known.
          line: 1
          col: 18
          category: api
      hints:
        - consider lowering circular segments
      "
    `);
  });

  it('serializes a report with stats (bbox, volume, triangles)', () => {
    const r = emptyReport('ok');
    r.stats = {
      triangles: 12,
      vertices: 8,
      volume: 1000,
      surfaceArea: 600,
      genus: 0,
      bbox: {
        min: [-5, -5, -5],
        max: [5, 5, 5],
        size: [10, 10, 10],
      },
    };
    expect(reportToYaml(r)).toMatchInlineSnapshot(`
      "ok: true
      stage: ok
      errors: []
      warnings: []
      hints: []
      stats:
        triangles: 12
        vertices: 8
        volume: 1000
        surfaceArea: 600
        genus: 0
        bbox:
          min:
            - -5
            - -5
            - -5
          max:
            - 5
            - 5
            - 5
          size:
            - 10
            - 10
            - 10
      "
    `);
  });
});
