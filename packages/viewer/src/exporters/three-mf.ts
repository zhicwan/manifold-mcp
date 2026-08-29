import { fileForContentTypes, FileForRelThumbnail, to3dmodel } from '@jscadui/3mf-export';
import { strToU8, zipSync } from 'fflate';

import { packPositions } from '../scene/mesh-bridge.js';
import type { PreviewPayload } from '../types.js';

/**
 * Serialize a mesh payload as a 3MF file. 3MF preserves manifold topology
 * (indexed triangles share vertices), so this is the recommended export
 * format for further CAD/slicer usage.
 */
export function export3mf(payload: PreviewPayload): Blob {
  const id = '1';
  const positions = packPositions(payload);
  const model = to3dmodel({
    meshes: [{ id, vertices: positions, indices: payload.triVerts }],
    components: [
      {
        id: '2',
        name: payload.description || 'model',
        children: [{ objectID: id }],
      },
    ],
    items: [{ objectID: '2' }],
    precision: 7,
    header: {
      unit: 'millimeter',
      title: payload.description || 'manifold3d-mcp model',
      application: 'manifold3d-mcp',
      creationDate: new Date(),
    },
  });

  const rels = new FileForRelThumbnail();
  rels.add3dModel('3D/3dmodel.model');

  const files: Record<string, Uint8Array> = {
    '3D/3dmodel.model': strToU8(model),
    [fileForContentTypes.name]: strToU8(fileForContentTypes.content),
    [rels.name]: strToU8(rels.content),
  };
  const zipped = zipSync(files);
  // Cast for strict BlobPart typing (zipped's buffer is ArrayBufferLike).
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'model/3mf' });
}
