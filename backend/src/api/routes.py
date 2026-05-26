"""API route handlers."""

from __future__ import annotations

import json
import logging
import time
import numpy as np
import cv2

logger = logging.getLogger(__name__)
from fastapi import File, Form, UploadFile
from pydantic import ValidationError as PydanticValidationError
from typing import Optional

from src.api.config import get_settings

from src.api.models import (
    DetectResponse,
    SubmitResponse,
    BoundingBox,
    Point,
    PuzzleState,
    SolveResponse,
    Solution,
    HintResponse,
    PuzzleInfoResponse,
    PuzzleInfo,
    MatchTrianglesRequest,
    MatchTrianglesResponse,
)
from src.api.exceptions import BadRequestError, ValidationError
from src.core.detection import detect_pieces
from src.core.image_processing import process_bounding_boxes_to_triangles
from src.core.clustering import cluster_triangles
from src.core.utils import image_to_base64
from src.core.solve import solve_puzzle, get_puzzle_hint, get_puzzle_info
from src.core.triangle_matching import (
    decode_base64_image,
    match_cluster_representatives,
)

settings = get_settings()

ParsedPuzzleState = tuple[
    dict[str, list[int]],
    dict[int, int],
    tuple[dict[str, int] | None, dict[str, int] | None] | None,
]


async def _read_upload_image(image: UploadFile) -> np.ndarray:
    """Read an UploadFile into an OpenCV BGR image with shared validation."""
    contents = await image.read()
    if len(contents) > settings.max_upload_bytes:
        raise BadRequestError(
            f"Image upload exceeds {settings.max_upload_bytes // (1024 * 1024)} MB limit"
        )

    nparr = np.frombuffer(contents, np.uint8)
    img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise BadRequestError("Invalid image format")
    return img_bgr


def _parse_json_field(value: str, field_name: str) -> object:
    """Parse a JSON form field and report client-side errors consistently."""
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"{field_name} must be valid JSON") from exc


def _validate_puzzle_state(request: PuzzleState) -> None:
    """Ensure a ``PuzzleState`` payload has nine pieces with four edges each.

    Args:
        request: Incoming puzzle definition.

    Returns:
        None

    Raises:
        ValidationError: If piece count, edge cardinality, or matches dict is invalid.
    """
    if not request.pieces or len(request.pieces) != 9:
        raise ValidationError("Must provide exactly 9 pieces")

    if not request.matches:
        raise ValidationError("Must provide matches dictionary")

    for piece_id, edges in request.pieces.items():
        if len(edges) != 4:
            raise ValidationError(
                f"Piece {piece_id} must have exactly 4 edge cluster IDs"
            )


def _parse_puzzle_state(request: PuzzleState) -> ParsedPuzzleState:
    """Parse and convert ``PuzzleState`` to internal solver formats.

    Args:
        request: Incoming JSON body validated as ``PuzzleState``.

    Returns:
        Tuple ``(pieces, matches_int, current_placements)`` where ``matches_int``
        uses integer keys, and ``current_placements`` is either ``None`` or
        ``(positions_dict, rotations_dict)`` from ``CurrentPlacements``.
    """
    _validate_puzzle_state(request)

    # Convert matches keys from string to int (cluster IDs are integers)
    try:
        matches_int = {int(k): v for k, v in request.matches.items()}
    except ValueError as exc:
        raise ValidationError("Match keys must be integer cluster IDs") from exc

    # Build current placements tuple if provided
    current_placements = None
    if request.currentPlacements is not None:
        current_placements = (
            request.currentPlacements.currentPositions,
            request.currentPlacements.currentRotations,
        )

    return request.pieces, matches_int, current_placements


async def detect_pieces_endpoint(image: UploadFile = File(...)) -> DetectResponse:
    """Detect nine puzzle pieces in an uploaded image.

    Args:
        image: Raw image file (decoded as BGR by OpenCV).

    Returns:
        ``DetectResponse`` with nine ``BoundingBox`` records in API order.

    Raises:
        BadRequestError: If the file is not a valid image or detection does not
            yield exactly nine pieces.
    """
    start_total = time.time()

    # Read image
    t0 = time.time()
    img_bgr = await _read_upload_image(image)
    timing_read = time.time() - t0

    t0 = time.time()
    boxes_data = detect_pieces(
        img_bgr,
        debug=settings.debug_detection,
    )
    timing_detect = time.time() - t0

    if len(boxes_data) != 9:
        raise BadRequestError(f"Expected 9 pieces, found {len(boxes_data)}")

    timing_total = time.time() - start_total
    logger.info(
        "/api/detect - Read: %.3fs, Detect: %.3fs, Total: %.3fs",
        timing_read, timing_detect, timing_total,
    )

    # Convert to API format
    bounding_boxes = []
    for i, box in enumerate(boxes_data, start=1):
        bbox = BoundingBox(
            id=f"box-{i}-{int(time.time() * 1000)}",
            topLeft=Point(x=box[0], y=box[1]),
            topRight=Point(x=box[2], y=box[3]),
            bottomRight=Point(x=box[4], y=box[5]),
            bottomLeft=Point(x=box[6], y=box[7]),
        )
        bounding_boxes.append(bbox)

    return DetectResponse(boundingBoxes=bounding_boxes)


async def submit_bounding_boxes_endpoint(
    image: UploadFile = File(...),
    indexedBoundingBoxes: Optional[str] = Form(None),
    boundingBoxes: Optional[str] = Form(None),
) -> SubmitResponse:
    """Warp submitted boxes, emit triangle crops, and assign edge clusters.

    Args:
        image: Source photograph containing the puzzle.
        indexedBoundingBoxes: Optional JSON string mapping piece index strings
            ``"0"`` through ``"8"`` to ``BoundingBox`` objects.
        boundingBoxes: Optional JSON list of nine boxes; when used, boxes are
            sorted by centroid for stable piece ordering.

    Returns:
        ``SubmitResponse`` with base64 PNGs for triangles and full pieces,
        cluster ids, ``pieceTriangles`` mapping, optional timing map, and message.

    Raises:
        BadRequestError: For invalid image data or unexpected piece/triangle counts.
        ValidationError: If form fields are missing or malformed.
    """
    start_total = time.time()
    timing = {}

    # Read image
    t0 = time.time()
    img_bgr = await _read_upload_image(image)
    timing["image_read_decode"] = time.time() - t0

    # Parse bounding boxes
    t0 = time.time()
    if indexedBoundingBoxes:
        boxes_dict = _parse_json_field(indexedBoundingBoxes, "indexedBoundingBoxes")
        if not isinstance(boxes_dict, dict):
            raise ValidationError("indexedBoundingBoxes must be a dictionary")

        expected_indices = set(str(i) for i in range(9))
        received_indices = set(boxes_dict.keys())
        if received_indices != expected_indices:
            raise ValidationError(
                f"Expected piece indices {expected_indices}, got {received_indices}"
            )

        indexed_boxes = {}
        for piece_idx_str in sorted(boxes_dict.keys(), key=int):
            try:
                indexed_boxes[piece_idx_str] = BoundingBox(**boxes_dict[piece_idx_str])
            except PydanticValidationError as exc:
                raise ValidationError(
                    f"Invalid bounding box for piece {piece_idx_str}"
                ) from exc

        piece_indices = sorted(indexed_boxes.keys(), key=int)
        bounding_boxes_api = [indexed_boxes[idx] for idx in piece_indices]

    elif boundingBoxes:
        boxes_data = _parse_json_field(boundingBoxes, "boundingBoxes")
        if not isinstance(boxes_data, list):
            raise ValidationError("boundingBoxes must be a list")
        try:
            bounding_boxes_api = [BoundingBox(**box) for box in boxes_data]
        except PydanticValidationError as exc:
            raise ValidationError("Invalid boundingBoxes payload") from exc

        box_with_centroids = []
        for i, box in enumerate(bounding_boxes_api):
            cx = (
                box.topLeft.x + box.topRight.x + box.bottomRight.x + box.bottomLeft.x
            ) / 4.0
            cy = (
                box.topLeft.y + box.topRight.y + box.bottomRight.y + box.bottomLeft.y
            ) / 4.0
            box_with_centroids.append((i, box, cx, cy))

        box_with_centroids.sort(key=lambda x: (x[3], x[2]))
        bounding_boxes_api = [box for _, box, _, _ in box_with_centroids]
        piece_indices = [str(i) for i in range(9)]
    else:
        raise ValidationError(
            "Must provide either indexedBoundingBoxes or boundingBoxes"
        )

    timing["parse_bboxes"] = time.time() - t0

    if len(bounding_boxes_api) != 9:
        raise ValidationError(
            f"Expected 9 bounding boxes, got {len(bounding_boxes_api)}"
        )

    # Convert API format to core format
    bounding_boxes_core = []
    for box in bounding_boxes_api:
        bounding_boxes_core.append(
            (
                box.topLeft.x,
                box.topLeft.y,
                box.topRight.x,
                box.topRight.y,
                box.bottomRight.x,
                box.bottomRight.y,
                box.bottomLeft.x,
                box.bottomLeft.y,
            )
        )

    # Process to pieces and triangles
    t0 = time.time()
    pieces, triangles, tri_masks = process_bounding_boxes_to_triangles(
        img_bgr, bounding_boxes_core
    )
    timing["warp_and_split"] = time.time() - t0

    # Build pieceTriangles mapping
    piece_triangles = {}
    triangle_idx = 0
    for piece_idx_str in piece_indices:
        piece_triangles[piece_idx_str] = [
            triangle_idx,
            triangle_idx + 1,
            triangle_idx + 2,
            triangle_idx + 3,
        ]
        triangle_idx += 4

    if len(pieces) != 9:
        raise BadRequestError(f"Expected 9 pieces, got {len(pieces)}")

    if len(triangles) != 36:
        raise BadRequestError(f"Expected 36 triangles, got {len(triangles)}")

    # Cluster triangles by similarity
    t0 = time.time()
    clusters = cluster_triangles(
        triangles, tri_masks, k=8, debug=settings.debug_clustering,
    )
    timing["clustering"] = time.time() - t0

    # Convert to base64
    t0 = time.time()
    triangles_base64 = [image_to_base64(tri) for tri in triangles]
    pieces_base64 = [image_to_base64(piece) for piece in pieces]
    timing["base64_encode"] = time.time() - t0

    timing["total"] = time.time() - start_total

    return SubmitResponse(
        success=True,
        images=triangles_base64,
        pieces=pieces_base64,
        clusters=clusters,
        pieceTriangles=piece_triangles,
        message=f"Successfully processed 9 pieces and 36 triangles (total: {timing['total']:.3f}s)",
        timing=timing,
    )


async def get_puzzle_info_endpoint(request: PuzzleState) -> PuzzleInfoResponse:
    """Enumerate solutions and return difficulty-style statistics.

    Args:
        request: Declared pieces, cluster matches, and optional placements.

    Returns:
        ``PuzzleInfoResponse`` with all solutions, the best solution, and
        ``PuzzleInfo`` metrics.

    Raises:
        ValidationError: If the puzzle payload fails structural checks.
        NoSolutionError: Propagated when the configuration is unsolvable.
    """
    pieces, matches_int, current_placements = _parse_puzzle_state(request)

    (
        solutions,
        best_solution,
        difficulty,
        num_valid_quads,
        num_solutions,
        num_unique_solutions,
    ) = get_puzzle_info(pieces, matches_int, current_placements)

    solutions_api = [
        Solution(positions=positions, rotations=rotations)
        for positions, rotations in solutions
    ]
    best_solution_api = Solution(positions=best_solution[0], rotations=best_solution[1])

    return PuzzleInfoResponse(
        solutions=solutions_api,
        bestSolution=best_solution_api,
        info=PuzzleInfo(
            numValidQuads=num_valid_quads,
            difficulty=difficulty,
            numSolutions=num_solutions,
            numUniqueSolutions=num_unique_solutions,
        ),
    )


async def get_puzzle_hint_endpoint(request: PuzzleState) -> HintResponse:
    """Return one suggested piece placement relative to the best solution.

    Args:
        request: Declared pieces, cluster matches, and optional placements.

    Returns:
        ``HintResponse`` naming the piece, grid position, and rotation.

    Raises:
        ValidationError: If the puzzle payload fails structural checks.
        NoSolutionError: If no solution exists.
        PuzzleSolvedError: If the board already matches a solved state.
    """
    pieces, matches_int, current_placements = _parse_puzzle_state(request)

    position, piece = get_puzzle_hint(pieces, matches_int, current_placements)

    return HintResponse(piece=piece.piece_id, position=position, rotation=piece.rotation)


async def solve_puzzle_endpoint(request: PuzzleState) -> SolveResponse:
    """Compute all valid layouts and the best match to the optional current state.

    Args:
        request: Declared pieces, cluster matches, and optional placements.

    Returns:
        ``SolveResponse`` listing every ``Solution`` plus ``bestSolution``.

    Raises:
        ValidationError: If the puzzle payload fails structural checks.
        NoSolutionError: If no arrangement satisfies the constraints.
    """
    pieces, matches_int, current_placements = _parse_puzzle_state(request)

    all_solutions, best_solution = solve_puzzle(pieces, matches_int, current_placements)

    solutions_api = [
        Solution(positions=positions, rotations=rotations)
        for positions, rotations in all_solutions
    ]
    best_solution_api = Solution(positions=best_solution[0], rotations=best_solution[1])

    return SolveResponse(solutions=solutions_api, bestSolution=best_solution_api)


async def match_triangles_endpoint(
    request: MatchTrianglesRequest,
) -> MatchTrianglesResponse:
    """Pair cluster representatives by color histogram similarity.

    Args:
        request: Base64 triangle images and parallel ``clusterIds`` list.

    Returns:
        ``MatchTrianglesResponse`` whose ``matchingOrder`` encodes top/bottom pairings.

    Raises:
        ValidationError: If lengths mismatch or cluster count is not an even >= 2.
        BadRequestError: If an image fails base64 decoding.
    """
    start = time.time()

    n = len(request.images)
    if n != len(request.clusterIds):
        raise ValidationError(
            "images and clusterIds must have the same length"
        )
    if n < 2 or n % 2 != 0:
        raise ValidationError(
            f"Expected an even number of images (>= 2), got {n}"
        )

    try:
        bgr_images = [decode_base64_image(img) for img in request.images]
    except (ValueError, TypeError, cv2.error) as exc:
        raise BadRequestError(f"Failed to decode image: {exc}") from exc

    pairs = match_cluster_representatives(bgr_images, debug=settings.debug_clustering)

    cluster_ids = request.clusterIds
    half = n // 2
    tops: list[int] = []
    bots: list[int] = []
    for i, j in pairs:
        tops.append(cluster_ids[i])
        bots.append(cluster_ids[j])

    matching_order = tops + bots

    elapsed = time.time() - start
    logger.info("/api/match-triangles - %d clusters, %.3fs", n, elapsed)

    return MatchTrianglesResponse(matchingOrder=matching_order)
