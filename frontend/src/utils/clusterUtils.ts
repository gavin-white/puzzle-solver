/**
 * Triangle list helpers: `TriangleItem` rows plus lookups from `pieceTriangles`.
 */
export interface TriangleItem {
  index: number;
  dataUri: string;
  pieceIndex: number;
  trianglePart: string;
}

/** Map global triangle index → physical piece index using `pieceTriangles`. */
export function getPieceIndexForTriangle(
  pieceTriangles: Record<string, number[]>,
  triangleIndex: number
): number | null {
  for (const [pieceIndexStr, triangleIndices] of Object.entries(pieceTriangles)) {
    if (triangleIndices.includes(triangleIndex)) {
      return parseInt(pieceIndexStr);
    }
  }
  if (Object.keys(pieceTriangles).length === 0) {
    return Math.floor(triangleIndex / 4);
  }
  return null;
}

/** Map triangle index → side name (`top` | `bottom` | `left` | `right`) for labels. */
export function getTrianglePart(
  pieceTriangles: Record<string, number[]>,
  triangleIndex: number
): string {
  for (const triangleIndices of Object.values(pieceTriangles)) {
    const index = triangleIndices.indexOf(triangleIndex);
    if (index !== -1) {
      return ['top', 'bottom', 'left', 'right'][index];
    }
  }
  if (Object.keys(pieceTriangles).length === 0) {
    return ['top', 'bottom', 'left', 'right'][triangleIndex % 4];
  }
  return 'unknown';
}
