"""Shared geometry utilities for point ordering and contour operations."""

from __future__ import annotations

import numpy as np


def order_points(pts: np.ndarray) -> np.ndarray:
    """Return four points ordered as top-left, top-right, bottom-right, bottom-left.

    Args:
        pts: Array of shape (4, 2) with point coordinates (x, y) in any order.

    Returns:
        ``numpy.ndarray`` of shape ``(4, 2)`` in ``float32``, corners ordered
        TL, TR, BR, BL for quadrilateral warping.
    """
    pts = pts.astype(np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.stack([tl, tr, br, bl], axis=0)
