import { describe, expect, it } from 'vitest';

import { supportsLocationSelection } from '../packages/viewer/src/host-actions/client.js';

describe('Viewer tool capabilities', () => {
  it('offers Select only when the host advertises location attachment', () => {
    expect(supportsLocationSelection([])).toBe(false);
    expect(supportsLocationSelection([{ id: 'attach-annotation-batch' }])).toBe(false);
    expect(supportsLocationSelection([{ id: 'attach-location-selection' }])).toBe(true);
  });
});
