export type GeometryByteArrays = Readonly<Record<string, ArrayBufferView | undefined>>;

export function estimateGeometryLiveBytes(
  arrays: GeometryByteArrays,
  options: Readonly<{ maximumOwnedFullMeshBuffers?: number }> = {},
): Readonly<{ meshBytes: number; previewBytes: number; totalBytes: number }> {
  const meshBuffers = new Set<ArrayBuffer>();
  const previewBuffers = new Set<ArrayBuffer>();
  for (const [name, array] of Object.entries(arrays)) {
    if (!array || array.byteLength === 0 || !(array.buffer instanceof ArrayBuffer)) continue;
    (name.toLowerCase().includes('preview') ? previewBuffers : meshBuffers).add(array.buffer);
  }
  if (options.maximumOwnedFullMeshBuffers !== undefined
    && meshBuffers.size > options.maximumOwnedFullMeshBuffers) {
    throw new RangeError('duplicate full-mesh buffers exceed the ownership boundary');
  }
  const bytes = (buffers: ReadonlySet<ArrayBuffer>): number => {
    let total = 0;
    for (const buffer of buffers) total += buffer.byteLength;
    return total;
  };
  const meshBytes = bytes(meshBuffers), previewBytes = bytes(previewBuffers);
  return Object.freeze({ meshBytes, previewBytes, totalBytes: meshBytes + previewBytes });
}
