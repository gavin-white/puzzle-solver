import type { BoundingBox, SolveRequest, SolveResponse, HintResponse, PuzzleInfoResponse, SubmitResponse, MatchTrianglesResponse } from '../types';

/** Test double for `ApiService`: delayed responses and placeholder imagery (no network). */
export class MockApiService {
  /** Return nine grid-aligned boxes from the image dimensions. */
  static async detectBoundingBoxes(imageFile: File): Promise<BoundingBox[]> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get image dimensions
    const imageUrl = URL.createObjectURL(imageFile);
    const img = new Image();
    
    return new Promise((resolve, reject) => {
      img.onload = () => {
        URL.revokeObjectURL(imageUrl);
        const width = img.width;
        const height = img.height;

        // Generate 9 bounding boxes in a 3x3 grid
        const boxes: BoundingBox[] = [];
        const cols = 3;
        const rows = 3;
        const boxWidth = width / cols;
        const boxHeight = height / rows;
        const padding = Math.min(width, height) * 0.05; // 5% padding

        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const x = col * boxWidth + padding;
            const y = row * boxHeight + padding;
            const w = boxWidth - padding * 2;
            const h = boxHeight - padding * 2;

            boxes.push({
              id: `mock-box-${row}-${col}-${Date.now()}`,
              topLeft: { x, y },
              topRight: { x: x + w, y },
              bottomLeft: { x, y: y + h },
              bottomRight: { x: x + w, y: y + h },
            });
          }
        }

        resolve(boxes);
      };

      img.onerror = () => {
        URL.revokeObjectURL(imageUrl);
        reject(new Error('Failed to load image for mock detection'));
      };

      img.src = imageUrl;
    });
  }

  /** Build a valid `SubmitResponse` with tiny placeholder PNG data URIs. */
  static async submitBoundingBoxes(
    _imageFile: File,
    indexedBoundingBoxes: Record<string, BoundingBox>
  ): Promise<SubmitResponse> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Generate 36 placeholder data URIs (9 pieces × 4 triangles each)
    // In a real implementation, these would be actual triangle images
    const images: string[] = [];
    for (let i = 0; i < 36; i++) {
      // Create a simple 1x1 transparent PNG as placeholder
      const placeholder = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      images.push(placeholder);
    }

    // Generate 9 piece images (full pieces)
    const pieces: string[] = [];
    for (let i = 0; i < 9; i++) {
      const placeholder = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      pieces.push(placeholder);
    }

    // Generate clusters (8 clusters, assign triangles to clusters)
    const clusters: number[] = [];
    const pieceTriangles: Record<string, number[]> = {};
    
    // Use the keys from indexedBoundingBoxes to determine piece order
    const pieceIndexes = Object.keys(indexedBoundingBoxes).sort((a, b) => parseInt(a) - parseInt(b));
    
    for (let i = 0; i < 36; i++) {
      clusters.push(i % 8); // Distribute triangles across 8 clusters
    }

    // Build pieceTriangles mapping: piece index -> [top, bottom, left, right] triangle indices
    pieceIndexes.forEach((pieceIndexStr, idx) => {
      const baseIndex = idx * 4;
      pieceTriangles[pieceIndexStr] = [baseIndex, baseIndex + 1, baseIndex + 2, baseIndex + 3];
    });

    return {
      success: true,
      images,
      pieces,
      clusters,
      pieceTriangles,
      message: `Successfully processed ${pieceIndexes.length} pieces (${images.length} triangles)`,
    };
  }

  /** Return a single mock solution (identity-ish positions, random rotations). */
  static async solvePuzzle(solveRequest: SolveRequest): Promise<SolveResponse> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Generate a mock solution where each piece goes to its "natural" position
    const positions: Record<string, number> = {};
    const rotations: Record<string, number> = {};

    Object.keys(solveRequest.pieces).forEach((pieceIndex, idx) => {
      positions[pieceIndex] = idx;
      rotations[pieceIndex] = Math.floor(Math.random() * 4); // Random rotation 0-3
    });

    const solution = { positions, rotations };

    return {
      solutions: [solution],
      bestSolution: solution,
    };
  }

  /** Random piece / position / rotation hint. */
  static async getHint(solveRequest: SolveRequest): Promise<HintResponse> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Find a random piece to hint
    const pieceIds = Object.keys(solveRequest.pieces);
    const randomPiece = pieceIds[Math.floor(Math.random() * pieceIds.length)];

    return {
      piece: randomPiece,
      position: Math.floor(Math.random() * 9),
      rotation: Math.floor(Math.random() * 4),
    };
  }

  /** Fixed stats plus the same mock solution shape as `solvePuzzle`. */
  static async getPuzzleInfo(solveRequest: SolveRequest): Promise<PuzzleInfoResponse> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Generate a mock solution
    const positions: Record<string, number> = {};
    const rotations: Record<string, number> = {};

    Object.keys(solveRequest.pieces).forEach((pieceIndex, idx) => {
      positions[pieceIndex] = idx;
      rotations[pieceIndex] = Math.floor(Math.random() * 4);
    });

    const solution = { positions, rotations };

    return {
      solutions: [solution],
      bestSolution: solution,
      info: {
        numValidQuads: 24,
        difficulty: 3,
        numSolutions: 4,
        numUniqueSolutions: 1,
      },
    };
  }

  /** Randomly split `clusterIds` into two halves for `matchingOrder` (tops then bottoms). */
  static async matchTriangles(_images: string[], clusterIds: number[]): Promise<MatchTrianglesResponse> {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const n = clusterIds.length;
    const half = Math.floor(n / 2);
    const shuffled = [...clusterIds].sort(() => Math.random() - 0.5);
    const tops = shuffled.slice(0, half);
    const bots = shuffled.slice(half);
    return { matchingOrder: [...tops, ...bots] };
  }
}

