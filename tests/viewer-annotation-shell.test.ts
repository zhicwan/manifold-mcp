import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Viewer annotation shell', () => {
  it('keeps annotation editing on-model and moves transactions to the bottom bar', async () => {
    const [rail, app] = await Promise.all([
      readFile(resolve(import.meta.dirname, '../packages/viewer/src/components/right-rail.tsx'), 'utf8'),
      readFile(resolve(import.meta.dirname, '../packages/viewer/src/components/viewer-app.tsx'), 'utf8'),
    ]);

    expect(rail).toContain("mode: 'annotate'");
    expect(rail).toContain("mode: 'select'");
    expect(rail).toContain("action.id === 'attach-location-selection'");
    expect(rail).not.toContain('标注列表');
    expect(rail).not.toContain('AnnotationFooterHostActions');
    expect(app).toContain('<AnnotationBatchBar />');
  });
});
