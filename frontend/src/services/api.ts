/**
 * HTTP client for the puzzle backend. Delegates to {@link MockApiService} when
 * `VITE_USE_MOCK_API` is enabled. Responses are validated with Zod schemas.
 */
import type { BoundingBox, SolveRequest, SolveResponse, SubmitResponse, HintResponse, PuzzleInfoResponse, MatchTrianglesResponse } from '../types';
import { ZodError, type ZodType } from 'zod';
import {
  DetectResponseSchema,
  SubmitResponseSchema,
  SolveResponseSchema,
  HintResponseSchema,
  PuzzleInfoResponseSchema,
  MatchTrianglesResponseSchema,
} from '../types';
import { MockApiService } from './mockApi';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
const USE_MOCK_API = import.meta.env.VITE_USE_MOCK_API === 'true' || import.meta.env.VITE_USE_MOCK_API === '1';

/** Best-effort parse of FastAPI `detail` / generic `message` from a failed response. */
export async function getErrorMessage(response: Response, defaultMessage: string): Promise<string> {
  try {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const errorData = await response.json();
      if (errorData.detail) return errorData.detail;
      if (errorData.message) return errorData.message;
    }
  } catch {
    // fall back to default
  }
  return defaultMessage;
}

export function parseApiResponse<T>(schema: ZodType<T>, data: unknown, context: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`${context} response did not match the expected format.`);
    }
    throw error;
  }
}

export class ApiService {
  /** POST `/api/detect` — returns nine piece bounding boxes. */
  static async detectBoundingBoxes(imageFile: File): Promise<BoundingBox[]> {
    if (USE_MOCK_API) {
      return MockApiService.detectBoundingBoxes(imageFile);
    }

    const formData = new FormData();
    formData.append('image', imageFile);

    const response = await fetch(`${API_BASE_URL}/api/detect`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, `Failed to detect bounding boxes: ${response.statusText}`));
    }

    const data = parseApiResponse(DetectResponseSchema, await response.json(), 'Detect');
    return data.boundingBoxes;
  }

  /** POST `/api/submit` — warps pieces, returns triangle images and cluster ids. */
  static async submitBoundingBoxes(
    imageFile: File,
    indexedBoundingBoxes: Record<string, BoundingBox>
  ): Promise<SubmitResponse> {
    if (USE_MOCK_API) {
      return MockApiService.submitBoundingBoxes(imageFile, indexedBoundingBoxes);
    }

    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('indexedBoundingBoxes', JSON.stringify(indexedBoundingBoxes));

    const response = await fetch(`${API_BASE_URL}/api/submit`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, `Failed to submit bounding boxes: ${response.statusText}`));
    }

    return parseApiResponse(SubmitResponseSchema, await response.json(), 'Submit');
  }

  /** POST `/api/solve` — all solutions and best solution for the given edges/matches. */
  static async solvePuzzle(solveRequest: SolveRequest): Promise<SolveResponse> {
    if (USE_MOCK_API) {
      return MockApiService.solvePuzzle(solveRequest);
    }

    const response = await fetch(`${API_BASE_URL}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(solveRequest),
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, `Failed to solve puzzle: ${response.statusText}`));
    }

    return parseApiResponse(SolveResponseSchema, await response.json(), 'Solve');
  }

  /** POST `/api/hint` — next suggested piece placement. */
  static async getHint(solveRequest: SolveRequest): Promise<HintResponse> {
    if (USE_MOCK_API) {
      return MockApiService.getHint(solveRequest);
    }

    const response = await fetch(`${API_BASE_URL}/api/hint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(solveRequest),
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, `Failed to get hint: ${response.statusText}`));
    }

    return parseApiResponse(HintResponseSchema, await response.json(), 'Hint');
  }

  /** POST `/api/info` — solutions plus difficulty / quad statistics. */
  static async getPuzzleInfo(solveRequest: SolveRequest): Promise<PuzzleInfoResponse> {
    if (USE_MOCK_API) {
      return MockApiService.getPuzzleInfo(solveRequest);
    }

    const response = await fetch(`${API_BASE_URL}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(solveRequest),
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, `Failed to get puzzle info: ${response.statusText}`));
    }

    return parseApiResponse(PuzzleInfoResponseSchema, await response.json(), 'Puzzle info');
  }

  /** POST `/api/match-triangles` — pairing order for cluster representative images. */
  static async matchTriangles(images: string[], clusterIds: number[]): Promise<MatchTrianglesResponse> {
    if (USE_MOCK_API) {
      return MockApiService.matchTriangles(images, clusterIds);
    }

    const response = await fetch(`${API_BASE_URL}/api/match-triangles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, clusterIds }),
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, `Failed to match triangles: ${response.statusText}`));
    }

    return parseApiResponse(MatchTrianglesResponseSchema, await response.json(), 'Triangle matching');
  }
}
