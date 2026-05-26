"""Image processing: warping, triangle splitting, rotation."""

from __future__ import annotations

from typing import List, Tuple, Dict
import cv2
import numpy as np
from .geometry import order_points


def warp_contour_to_square(
    img_bgr: np.ndarray, quad: np.ndarray, warp_size: int = 256
) -> np.ndarray | None:
    """Warp the quadrilateral region of ``img_bgr`` into a square view.

    Args:
        img_bgr: Source image in BGR.
        quad: Four vertices ``(x, y)`` in image space; order is normalized via
            ``order_points``. If fewer than four points, returns ``None``.
        warp_size: Output square side length in pixels.

    Returns:
        Warped ``(warp_size, warp_size, 3)`` BGR image, or ``None`` if ``quad``
        is invalid.
    """
    if quad is None or len(quad) < 4:
        return None

    src = order_points(quad.astype(np.float32))
    dst = np.array(
        [
            [0, 0],
            [warp_size - 1, 0],
            [warp_size - 1, warp_size - 1],
            [0, warp_size - 1],
        ],
        dtype=np.float32,
    )

    m = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(
        img_bgr, m, (warp_size, warp_size), flags=cv2.INTER_CUBIC
    )


def triangle_masks(h: int, w: int) -> Dict[str, np.ndarray]:
    """Build binary masks for the four triangles defined by square diagonals.

    Args:
        h: Image height in pixels.
        w: Image width in pixels.

    Returns:
        Dict with keys ``top``, ``bottom``, ``left``, ``right`` mapping to
        ``uint8`` masks (0 / 255) of shape ``(h, w)``.
    """
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    pts = {
        "top": np.array([[0, 0], [w - 1, 0], [cx, cy]], dtype=np.float32),
        "bottom": np.array([[0, h - 1], [w - 1, h - 1], [cx, cy]], dtype=np.float32),
        "left": np.array([[0, 0], [0, h - 1], [cx, cy]], dtype=np.float32),
        "right": np.array([[w - 1, 0], [w - 1, h - 1], [cx, cy]], dtype=np.float32),
    }
    masks = {}
    for name, p in pts.items():
        m = np.zeros((h, w), dtype=np.uint8)
        cv2.fillConvexPoly(m, p.astype(np.int32), 255)
        masks[name] = m
    return masks


def rotate_pair(
    img: np.ndarray, mask: np.ndarray, part: str
) -> Tuple[np.ndarray, np.ndarray]:
    """Rotate image and mask so the triangle base faces downward.

    Mapping: ``top`` -> 180°, ``bottom`` unchanged, ``left`` -> 90° CCW,
    ``right`` -> 90° CW; unknown ``part`` leaves inputs unchanged.

    Args:
        img: BGR image aligned to ``mask``.
        mask: Single-channel mask aligned to ``img``.
        part: One of ``"top"``, ``"bottom"``, ``"left"``, ``"right"``.

    Returns:
        Tuple ``(rotated_image, rotated_mask)`` with identical layout rules.
    """
    if part == "top":
        rot = cv2.ROTATE_180
    elif part == "bottom":
        return img, mask
    elif part == "left":
        rot = cv2.ROTATE_90_COUNTERCLOCKWISE
    elif part == "right":
        rot = cv2.ROTATE_90_CLOCKWISE
    else:
        return img, mask
    return cv2.rotate(img, rot), cv2.rotate(mask, rot)


def crop_to_mask(
    img: np.ndarray, mask: np.ndarray, pad: int = 2
) -> Tuple[np.ndarray, np.ndarray]:
    """Crop ``img`` and ``mask`` to the axis-aligned bbox of nonzero mask pixels.

    Args:
        img: Image to crop.
        mask: Mask whose positive pixels define the crop; if empty, inputs are
            returned unchanged.
        pad: Extra border in pixels on each side of the bbox (clamped to image).

    Returns:
        Tuple of cropped ``(img, mask)`` copies.
    """
    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return img, mask
    x0, x1 = max(0, int(xs.min()) - pad), min(img.shape[1], int(xs.max()) + pad + 1)
    y0, y1 = max(0, int(ys.min()) - pad), min(img.shape[0], int(ys.max()) + pad + 1)
    return img[y0:y1, x0:x1].copy(), mask[y0:y1, x0:x1].copy()


def make_base_down_triangle_and_mask(
    warp_bgr: np.ndarray, part: str, pad: int = 2
) -> Tuple[np.ndarray, np.ndarray]:
    """Extract one triangle from a warped square with base oriented downward.

    Args:
        warp_bgr: Square BGR crop of a puzzle piece.
        part: Triangle name: ``"top"``, ``"bottom"``, ``"left"``, or ``"right"``.
        pad: Padding passed to ``crop_to_mask``.

    Returns:
        Tuple ``(tri_bgr, tri_mask)`` where ``tri_bgr`` has non-triangle pixels
        blacked out and ``tri_mask`` is ``uint8`` 0/255 aligned to ``tri_bgr``.
    """
    h, w = warp_bgr.shape[:2]
    masks = triangle_masks(h, w)
    m = masks[part]

    tri_full = cv2.bitwise_and(warp_bgr, warp_bgr, mask=m)
    tri_rot, m_rot = rotate_pair(tri_full, m, part)
    tri_crop, m_crop = crop_to_mask(tri_rot, m_rot, pad=pad)

    # Ensure outside triangle is black
    tri_crop = cv2.bitwise_and(
        tri_crop, tri_crop, mask=(m_crop > 0).astype(np.uint8) * 255
    )

    return tri_crop, m_crop


def process_bounding_boxes_to_triangles(
    img_bgr: np.ndarray,
    bounding_boxes: List[Tuple[float, float, float, float, float, float, float, float]],
    warp_size: int = 256,
) -> Tuple[List[np.ndarray], List[np.ndarray], List[np.ndarray]]:
    """Warp each box to a square, split into four triangles, and orient bases down.

    Args:
        img_bgr: Full source image in BGR.
        bounding_boxes: Nine tuples ``(tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y)``.
        warp_size: Side length in pixels for each warped square.

    Returns:
        Tuple ``(pieces, triangles, masks)``:
        ``pieces`` — nine ``(warp_size, warp_size, 3)`` BGR crops;
        ``triangles`` — thirty-six base-down triangle crops;
        ``masks`` — thirty-six aligned ``uint8`` binary masks (0/255).
    """
    pieces = []
    triangles = []
    masks = []

    for box in bounding_boxes:
        quad = np.array(
            [
                [box[0], box[1]],
                [box[2], box[3]],
                [box[4], box[5]],
                [box[6], box[7]],
            ],
            dtype=np.float32,
        )

        warped = warp_contour_to_square(img_bgr, quad, warp_size=warp_size)
        if warped is None:
            warped = np.zeros((warp_size, warp_size, 3), dtype=np.uint8)

        h, w = warped.shape[:2]
        m = min(h, w)
        warped = warped[:m, :m].copy()
        if warped.shape[0] != warp_size or warped.shape[1] != warp_size:
            warped = cv2.resize(
                warped, (warp_size, warp_size), interpolation=cv2.INTER_CUBIC
            )

        pieces.append(warped.copy())

        for part in ["top", "bottom", "left", "right"]:
            tri, mask = make_base_down_triangle_and_mask(warped, part, pad=2)
            triangles.append(tri)
            masks.append(mask)

    return pieces, triangles, masks
