"""Geometric validation helpers for detected puzzle piece boxes."""

from __future__ import annotations

from typing import List, Tuple

import cv2
import numpy as np

from .geometry import order_points


def _validate_box_sizes(bounding_boxes: List[Tuple[float, ...]]) -> List[str]:
    """Check that all 9 boxes are similar in area."""
    if len(bounding_boxes) != 9:
        return [f"Expected 9 boxes, got {len(bounding_boxes)}"]

    areas = []
    for box in bounding_boxes:
        corners = np.array(
            [[box[0], box[1]], [box[2], box[3]], [box[4], box[5]], [box[6], box[7]]],
            dtype=np.float32,
        )
        areas.append(cv2.contourArea(corners))

    if not areas:
        return ["No boxes to validate"]

    median_area = np.median(areas)
    ratio_threshold = 2.0
    for i, area in enumerate(areas):
        if median_area <= 0 or area <= 0:
            return [f"Box {i+1} has zero area"]
        ratio = area / median_area
        if ratio > ratio_threshold:
            return [
                f"Box {i+1} is {ratio:.2f}x larger than median "
                f"(area={area:.0f} vs median={median_area:.0f})"
            ]
        if ratio < 1.0 / ratio_threshold:
            return [
                f"Box {i+1} is {1/ratio:.2f}x smaller than median "
                f"(area={area:.0f} vs median={median_area:.0f})"
            ]
    return []


def _validate_box_overlap(bounding_boxes: List[Tuple[float, ...]]) -> List[str]:
    """Check that boxes do not overlap more than 20%."""
    if len(bounding_boxes) != 9:
        return []

    overlap_threshold = 0.20
    rects = []
    for box in bounding_boxes:
        corners = np.array(
            [[box[0], box[1]], [box[2], box[3]], [box[4], box[5]], [box[6], box[7]]],
            dtype=np.float32,
        )
        rects.append(corners)

    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            area_i = cv2.contourArea(rects[i])
            area_j = cv2.contourArea(rects[j])
            if area_i == 0 or area_j == 0:
                continue

            min_x_i, max_x_i = rects[i][:, 0].min(), rects[i][:, 0].max()
            min_y_i, max_y_i = rects[i][:, 1].min(), rects[i][:, 1].max()
            min_x_j, max_x_j = rects[j][:, 0].min(), rects[j][:, 0].max()
            min_y_j, max_y_j = rects[j][:, 1].min(), rects[j][:, 1].max()

            overlap_x = max(0, min(max_x_i, max_x_j) - max(min_x_i, min_x_j))
            overlap_y = max(0, min(max_y_i, max_y_j) - max(min_y_i, min_y_j))
            overlap_area = overlap_x * overlap_y
            smaller_area = min(area_i, area_j)
            overlap_ratio = overlap_area / smaller_area if smaller_area > 0 else 0

            if overlap_ratio > overlap_threshold:
                return [
                    f"Boxes {i+1} and {j+1} overlap {overlap_ratio:.0%} "
                    f"(threshold: {overlap_threshold:.0%})"
                ]
    return []


def _validate_box_congruence(bounding_boxes: List[Tuple[float, ...]]) -> List[str]:
    """Check that boxes are close to congruent."""
    if len(bounding_boxes) != 9:
        return []

    widths = []
    heights = []
    for box in bounding_boxes:
        corners = np.array(
            [[box[0], box[1]], [box[2], box[3]], [box[4], box[5]], [box[6], box[7]]],
            dtype=np.float32,
        )
        ordered = order_points(corners)
        widths.append(float(np.linalg.norm(ordered[1] - ordered[0])))
        heights.append(float(np.linalg.norm(ordered[3] - ordered[0])))

    if not widths:
        return []

    median_w = np.median(widths)
    median_h = np.median(heights)
    tolerance = 0.5
    for i in range(len(widths)):
        w_ratio = widths[i] / median_w if median_w > 0 else 0
        h_ratio = heights[i] / median_h if median_h > 0 else 0
        if abs(w_ratio - 1.0) > tolerance:
            return [
                f"Box {i+1} width ratio {w_ratio:.2f} exceeds tolerance "
                f"(width={widths[i]:.0f} vs median={median_w:.0f})"
            ]
        if abs(h_ratio - 1.0) > tolerance:
            return [
                f"Box {i+1} height ratio {h_ratio:.2f} exceeds tolerance "
                f"(height={heights[i]:.0f} vs median={median_h:.0f})"
            ]
    return []


def validate_bounding_boxes(
    bounding_boxes: List[Tuple[float, ...]],
) -> List[str]:
    """Run geometric consistency checks on candidate piece bounding boxes."""
    errors = []
    errors.extend(_validate_box_sizes(bounding_boxes))
    errors.extend(_validate_box_overlap(bounding_boxes))
    errors.extend(_validate_box_congruence(bounding_boxes))
    return errors
