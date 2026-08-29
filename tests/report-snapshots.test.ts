/**
 * VAL-8 snapshot tests: lock the YAML wire-format we send back to MCP
 * clients for one report per stage exit. Updating these snapshots in a
 * PR is intentional surface — anything else is an accidental UX
 * regression for downstream LLM clients that parse the report.
 *
 * We use file-based snapshots (toMatchSnapshot) instead of inline
 * snapshots because vitest's inline-snapshot dedent algorithm mangles
 * lines that begin with whitespace + `|`, which is exactly what our
 * code-frame caret rows look like.
 */
import { describe, expect, it } from 'vitest';

import {
  addError,
  addHint,
  addWarning,
  buildCodeFrame,
  emptyReport,
  reportToYaml,
} from '../packages/modeling/src/validation/report.js';

function requiredCodeFrame(code: string, line: number, col: number, endLine?: number, endCol?: number): string {
  const frame = buildCodeFrame(code, line, col, endLine, endCol);
  if (frame === undefined) {
    throw new Error('Expected a code frame for a valid source location.');
  }
  return frame;
}

describe('reportToYaml — per-stage snapshots (VAL-8)', () => {
  it('ok: true empty-issue report', () => {
    const r = emptyReport('ok');
    r.stats = {
      triangles: 12,
      vertices: 8,
      volume: 1000,
      surfaceArea: 600,
      genus: 0,
      bbox: { min: [-5, -5, -5], max: [5, 5, 5], size: [10, 10, 10] },
    };
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('static FORBIDDEN_GLOBAL with code frame', () => {
    const code = 'process.exit(0);\nresult = Manifold.cube();\n';
    const r = emptyReport('static');
    addError(r, {
      stage: 'static',
      code: 'FORBIDDEN_GLOBAL',
      message: "Forbidden global 'process' is not available in the sandbox.",
      line: 1,
      col: 1,
      endLine: 1,
      endCol: 8,
      snippet: requiredCodeFrame(code, 1, 1, 1, 8),
    });
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('typecheck TS2339 with custom guidance', () => {
    const code = 'result = Manifold.box([10, 10, 10]);\n';
    const r = emptyReport('typecheck');
    addError(r, {
      stage: 'typecheck',
      code: 'TS_DIAGNOSTIC',
      tsCode: 2339,
      message:
        "Property 'box' does not exist on type 'typeof Manifold'.\nhint: Check the skill API reference for the supported method name or equivalent modeling recipe.",
      line: 1,
      col: 19,
      snippet: requiredCodeFrame(code, 1, 19),
    });
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('geometry EMPTY_RESULT with hint', () => {
    const r = emptyReport('geometry');
    r.stats = {
      triangles: 0,
      vertices: 0,
      volume: 0,
      surfaceArea: 0,
      genus: 0,
      bbox: { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] },
    };
    addError(r, {
      stage: 'geometry',
      code: 'EMPTY_RESULT',
      message:
        'Result is empty. Common causes include disjoint boolean operands, subtracting a shape from itself, invalid/non-finite warp output, or fully removing the part.',
    });
    addHint(
      r,
      'Check recent boolean operations, cutter/part bounding boxes, translation direction, subtract/intersect order, and any warp callbacks that can create NaN or Infinity.',
    );
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('geometry BBOX_TOO_LARGE warning on otherwise OK report', () => {
    const r = emptyReport('ok');
    r.stats = {
      triangles: 12,
      vertices: 8,
      volume: 1_000_000,
      surfaceArea: 60_000,
      genus: 0,
      bbox: { min: [0, 0, 0], max: [600, 100, 100], size: [600, 100, 100] },
    };
    addWarning(r, {
      stage: 'geometry',
      code: 'BBOX_TOO_LARGE',
      message: 'Largest bounding box dimension is 600.0 mm (> 500 mm); exceeds most consumer printers.',
    });
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('runtime TIMEOUT', () => {
    const r = emptyReport('runtime');
    addError(r, {
      stage: 'runtime',
      code: 'TIMEOUT',
      message: 'Script execution exceeded 5000 ms; possible infinite loop or huge geometry.',
    });
    r.durationMs = 5000;
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('runtime OUT_OF_MEMORY', () => {
    const r = emptyReport('runtime');
    addError(r, {
      stage: 'runtime',
      code: 'OUT_OF_MEMORY',
      message: 'Worker exceeded the 512 MB old-generation soft cap (exit 134; ERR_WORKER_OUT_OF_MEMORY).',
    });
    expect(reportToYaml(r)).toMatchSnapshot();
  });

  it('runtime WORKER_CRASH', () => {
    const r = emptyReport('runtime');
    addError(r, {
      stage: 'runtime',
      code: 'WORKER_CRASH',
      message: 'Worker exited unexpectedly with code 1.',
    });
    expect(reportToYaml(r)).toMatchSnapshot();
  });
});

describe('buildCodeFrame (VAL-5)', () => {
  it('renders a 3-line frame with caret on the column range', () => {
    const code = ['const a = 1;', 'const b = 2;', 'result = boom(a, b);', 'const c = 3;', 'const d = 4;'].join('\n');
    expect(buildCodeFrame(code, 3, 10, 3, 14)).toMatchSnapshot();
  });

  it('clamps to single line when source has only one line', () => {
    expect(buildCodeFrame('result = Manifold.box([1, 1, 1]);', 1, 10, 1, 18)).toMatchSnapshot();
  });

  it('returns undefined when line is out of range', () => {
    expect(buildCodeFrame('one line', 5, 1)).toBeUndefined();
  });

  it('returns undefined for empty source', () => {
    expect(buildCodeFrame('', 1, 1)).toBeUndefined();
  });
});
