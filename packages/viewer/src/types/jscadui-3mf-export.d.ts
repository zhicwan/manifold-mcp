// Hand-written ambient types for @jscadui/3mf-export. Upstream does not
// ship .d.ts files, so we declare just the surface we use. Keeping
// `creationDate` strictly typed as Date is what gives us a compile-time
// guard against mistakes like passing `new Date().toISOString()`.
declare module '@jscadui/3mf-export' {
  export interface FileEntry {
    readonly name: string;
    readonly content: string;
  }

  export const fileForContentTypes: FileEntry;

  export class FileForRelThumbnail {
    constructor();
    readonly name: string;
    readonly content: string;
    addRel(target: string, type: string): void;
    add3dModel(target: string): void;
    addThumbnail(target: string): void;
  }

  export interface To3dModelMesh {
    id: string;
    vertices: ArrayLike<number>;
    indices: ArrayLike<number>;
    name?: string;
  }

  export interface To3dModelComponent {
    id: string;
    name?: string;
    children: Array<{ objectID: string; transform?: number[] }>;
  }

  export interface To3dModelItem {
    objectID: string;
    transform?: number[];
  }

  export interface To3dModelHeader {
    unit?: 'micron' | 'millimeter' | 'centimeter' | 'inch' | 'foot' | 'meter';
    title?: string;
    author?: string;
    description?: string;
    application?: string;
    creationDate?: Date;
    license?: string;
    modificationDate?: Date;
  }

  export interface To3dModelOptions {
    meshes: To3dModelMesh[];
    components?: To3dModelComponent[];
    items: To3dModelItem[];
    precision?: number;
    header?: To3dModelHeader;
  }

  export function to3dmodel(opts: To3dModelOptions): string;
}
