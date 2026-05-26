/**
 * Zod schemas for API JSON validation and derived TypeScript types, plus
 * client-only shapes built in the UI.
 */
import { z } from 'zod';


const PointSchema = z.object({ x: z.number(), y: z.number() });

const BoundingBoxSchema = z.object({
  id: z.string(),
  topLeft: PointSchema,
  topRight: PointSchema,
  bottomLeft: PointSchema,
  bottomRight: PointSchema,
});

export const DetectResponseSchema = z.object({
  boundingBoxes: z.array(BoundingBoxSchema),
});

export const SubmitResponseSchema = z.object({
  success: z.boolean(),
  images: z.array(z.string()),
  pieces: z.array(z.string()),
  clusters: z.array(z.number()),
  pieceTriangles: z.record(z.string(), z.array(z.number())),
  message: z.string(),
  timing: z.record(z.string(), z.number()).optional(),
});

const SolutionDataSchema = z.object({
  positions: z.record(z.string(), z.number()),
  rotations: z.record(z.string(), z.number()),
});

export const SolveResponseSchema = z.object({
  solutions: z.array(SolutionDataSchema),
  bestSolution: SolutionDataSchema,
});

export const HintResponseSchema = z.object({
  piece: z.string(),
  position: z.number(),
  rotation: z.number(),
});

const PuzzleInfoDataSchema = z.object({
  numValidQuads: z.number(),
  difficulty: z.number(),
  numSolutions: z.number(),
  numUniqueSolutions: z.number(),
});

export const PuzzleInfoResponseSchema = z.object({
  solutions: z.array(SolutionDataSchema),
  bestSolution: SolutionDataSchema,
  info: PuzzleInfoDataSchema,
});

export const MatchTrianglesResponseSchema = z.object({
  matchingOrder: z.array(z.number()),
});


export type Point = z.infer<typeof PointSchema>;
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;
export type SolutionData = z.infer<typeof SolutionDataSchema>;
export type SolveResponse = z.infer<typeof SolveResponseSchema>;
export type HintResponse = z.infer<typeof HintResponseSchema>;
export type PuzzleInfoData = z.infer<typeof PuzzleInfoDataSchema>;
export type PuzzleInfoResponse = z.infer<typeof PuzzleInfoResponseSchema>;
export type MatchTrianglesResponse = z.infer<typeof MatchTrianglesResponseSchema>;


/** Snapshot of boxes for undo on the bounding-box step. */
export interface BoundingBoxHistory {
  boundingBoxes: BoundingBox[];
  timestamp: number;
}

/** Data persisted after `/api/submit`: image, boxes, and triangle/cluster payload. */
export interface SubmittedData {
  imageFile: File;
  imageUrl: string;
  boundingBoxes: BoundingBox[];
  pieceIndexMap: Map<number, number>;
  submitResponse: SubmitResponse;
  timestamp: number;
}

/** Optional live board state sent with solve/hint/info requests. */
export interface CurrentPlacements {
  currentPositions?: Record<string, number>;
  currentRotations?: Record<string, number>;
}

/** POST body for `/api/solve`, `/api/hint`, and `/api/info`. */
export interface SolveRequest {
  pieces: Record<string, number[]>;
  matches: Record<string, number>;
  currentPlacements?: CurrentPlacements;
}

/** Which full-page step of the upload-to-solve flow is active. */
export type PageType = 'home' | 'crop' | 'boundingBox' | 'clusterOrganizing' | 'clusterMatching' | 'solve' | 'play';
