"""API request/response models."""

from typing import List, Optional, Dict
from pydantic import BaseModel


class Point(BaseModel):
    """A 2D point in image coordinates."""

    x: float
    y: float


class BoundingBox(BaseModel):
    """Quadrilateral bounding box for one detected puzzle piece."""

    id: str
    topLeft: Point
    topRight: Point
    bottomLeft: Point
    bottomRight: Point


class DetectResponse(BaseModel):
    """Response from piece detection: nine bounding boxes."""

    boundingBoxes: List[BoundingBox]


class SubmitResponse(BaseModel):
    """Response after submitting boxes: warped pieces, triangles, and cluster ids."""

    success: bool
    images: List[str]  # Base64 encoded triangle images (36 total)
    pieces: List[str]  # Base64 encoded full piece images (9 total)
    clusters: List[
        int
    ]  # Cluster assignment for each triangle image (36 values, one per triangle)
    pieceTriangles: Dict[
        str, List[int]
    ]  # Piece index -> [top, bottom, left, right] triangle indices
    message: Optional[str] = None
    timing: Optional[Dict[str, float]] = None  # Timing information in seconds


class CurrentPlacements(BaseModel):
    """Optional live placement state for hint/solve/info requests."""

    currentPositions: Optional[Dict[str, int]] = None  # Piece index -> position (0-8)
    currentRotations: Optional[Dict[str, int]] = None  # Piece index -> rotation (0-3)


class PuzzleState(BaseModel):
    """Full puzzle definition: per-piece edge clusters, matches, and optional placements."""

    pieces: Dict[
        str, List[int]
    ]  # Piece index -> [top, right, bottom, left] cluster IDs
    matches: Dict[str, int]  # Cluster ID -> matching cluster ID
    # Optional current state - if not provided, assumes pieces are in original positions (piece i at position i)
    currentPlacements: Optional[CurrentPlacements] = None


class Solution(BaseModel):
    """A single puzzle solution."""

    positions: Dict[str, int]  # Piece index -> position index (0-8, row-major order)
    rotations: Dict[str, int]  # Piece index -> rotation (0-3)


class SolveResponse(BaseModel):
    """Response containing all solutions and the best solution."""

    solutions: List[Solution]  # All valid solutions
    bestSolution: Solution  # Best solution


class HintResponse(BaseModel):
    """Response containing a hint for the puzzle."""

    piece: str
    position: int
    rotation: int


class PuzzleInfo(BaseModel):
    """Model for puzzle information."""

    numValidQuads: int
    difficulty: int
    numSolutions: int
    numUniqueSolutions: int


class PuzzleInfoResponse(BaseModel):
    """Response containing solutions, best solution, and puzzle analysis metadata."""

    solutions: List[Solution]  # All valid solutions
    bestSolution: Solution  # Best solution
    info: PuzzleInfo


class MatchTrianglesRequest(BaseModel):
    """Request to match cluster representative triangle images into pairs."""

    images: List[str]  # Base64 encoded representative triangle images (one per cluster)
    clusterIds: List[int]  # Corresponding cluster ID for each image


class MatchTrianglesResponse(BaseModel):
    """Response with the suggested matching order for clusters."""

    matchingOrder: List[int]  # Cluster IDs reordered: [top0..topN, bot0..botN]
                              # Column i pairs matchingOrder[i] with matchingOrder[i + len/2]
