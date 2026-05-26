"""Puzzle piece detection pipeline.

Detects 9 puzzle pieces in an image and returns their bounding boxes.
The pipeline stages are:

1. Downsample — resize to manageable dimensions
2. Denoise — light Gaussian blur
3. Segment colors — K-means in LAB a,b space
4. Identify foreground — score primary background cluster; OR all other clusters; spatial CC filter for bleed
5. Clean mask — morphological ops, hole filling, speck removal
6. Find components — connected components filtered by area/aspect
7. Enforce nine regions — watershed splitting or pruning to exactly 9
7b. Clean component shapes (remove protrusions, clip to square-like)
8. Fit bounding boxes — oriented rectangles scaled to original coordinates
9. Refine corners — local crop segmentation at higher resolution
"""

from __future__ import annotations

import os
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .debug import DebugLogger, PipelineTimer
from .geometry import order_points
from .detection_validation import validate_bounding_boxes


_COMPONENT_COLORS = [
    (230, 80, 80), (80, 200, 80), (80, 80, 230),
    (220, 220, 60), (220, 60, 220), (60, 220, 220),
    (255, 160, 60), (160, 60, 255), (60, 255, 160),
]


def _colorize_components(
    shape: Tuple[int, int],
    masks: List[np.ndarray],
    base_img: Optional[np.ndarray] = None,
    alpha: float = 0.45,
) -> np.ndarray:
    """Create a colored overlay of component masks, optionally blended onto *base_img*."""
    h, w = shape
    overlay = np.zeros((h, w, 3), dtype=np.uint8)
    for i, mask in enumerate(masks):
        overlay[mask] = _COMPONENT_COLORS[i % len(_COMPONENT_COLORS)]

    if base_img is not None:
        vis = cv2.addWeighted(base_img, 1.0 - alpha, overlay, alpha, 0)
    else:
        vis = overlay.copy()

    for i, mask in enumerate(masks):
        mask_u8 = mask.astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            color = _COMPONENT_COLORS[i % len(_COMPONENT_COLORS)]
            cv2.drawContours(vis, contours, -1, color, 2)
            M = cv2.moments(max(contours, key=lambda c: float(cv2.contourArea(c))))
            if M["m00"] > 0:
                cx = int(M["m10"] / M["m00"])
                cy = int(M["m01"] / M["m00"])
                cv2.putText(
                    vis, str(i + 1), (cx - 8, cy + 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2,
                )
    return vis


def _downsample_pixels(img_lab: np.ndarray, max_samples: int = 200_000) -> np.ndarray:
    px = img_lab.reshape(-1, 3).astype(np.float32)
    n = px.shape[0]
    if n <= max_samples:
        return px
    idx = np.random.choice(n, size=max_samples, replace=False)
    return px[idx]


def _make_fallback_grid(
    w_orig: int, h_orig: int,
) -> List[Tuple[float, float, float, float, float, float, float, float]]:
    """Return 9 evenly-spaced bounding boxes covering the image."""
    grid_frac = 0.95
    box_area_frac = 0.80

    grid_w = w_orig * grid_frac
    grid_h = h_orig * grid_frac
    margin_x = (w_orig - grid_w) / 2
    margin_y = (h_orig - grid_h) / 2

    gap_x = grid_w * (1 - box_area_frac) / 2
    gap_y = grid_h * (1 - box_area_frac) / 2
    box_w = (grid_w - 2 * gap_x) / 3
    box_h = (grid_h - 2 * gap_y) / 3

    boxes: List[Tuple[float, float, float, float, float, float, float, float]] = []
    for row in range(3):
        for col in range(3):
            x0 = margin_x + col * (box_w + gap_x)
            x1 = x0 + box_w
            y0 = margin_y + row * (box_h + gap_y)
            y1 = y0 + box_h
            boxes.append((
                float(x0), float(y0),
                float(x1), float(y0),
                float(x1), float(y1),
                float(x0), float(y1),
            ))
    return boxes


def _fallback_adaptive_threshold(
    img: np.ndarray,
    w_orig: int,
    h_orig: int,
    scale_back_x: float,
    scale_back_y: float,
) -> List[Tuple[float, float, float, float, float, float, float, float]]:
    """Standard method: binarize with adaptive threshold, findContours, take 9 square-like regions.
    Tries both BINARY and BINARY_INV since pieces may be darker or lighter than background.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    block = max(11, (min(w, h) // 6) | 1)
    img_area = h * w
    expected = img_area / 9.0
    min_a, max_a = expected * 0.2, expected * 2.2

    for inv in (False, True):
        thresh_type = cv2.THRESH_BINARY_INV if inv else cv2.THRESH_BINARY
        binary = cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, thresh_type, block, 2,
        )
        contours, _ = cv2.findContours(
            binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
        )
        candidates: List[Tuple[float, np.ndarray]] = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_a or area > max_a:
                continue
            rect = cv2.minAreaRect(cnt)
            (_cx, _cy), (rw, rh), _ = rect
            rw, rh = max(1e-6, rw), max(1e-6, rh)
            aspect = max(rw, rh) / min(rw, rh)
            if aspect > 1.5:
                continue
            candidates.append((area, cnt))
        if len(candidates) < 9:
            continue
        candidates.sort(key=lambda x: abs(x[0] - expected))
        chosen = candidates[:9]
        boxes: List[Tuple[float, float, float, float, float, float, float, float]] = []
        for _area, cnt in chosen:
            rect = cv2.minAreaRect(cnt)
            corners = cv2.boxPoints(rect)
            corners = order_points(corners)
            corners[:, 0] *= scale_back_x
            corners[:, 1] *= scale_back_y
            corners = np.clip(corners, [0, 0], [w_orig - 1, h_orig - 1])
            boxes.append((
                float(corners[0][0]), float(corners[0][1]),
                float(corners[1][0]), float(corners[1][1]),
                float(corners[2][0]), float(corners[2][1]),
                float(corners[3][0]), float(corners[3][1]),
            ))
        return boxes
    return []


def _detect_squares_fallback(
    img_bgr: np.ndarray,
    w_orig: int,
    h_orig: int,
    max_dim: int = 500,
    dbg: Optional[DebugLogger] = None,
) -> Tuple[List[Tuple[float, float, float, float, float, float, float, float]], Optional[str]]:
    """Fallback when validation fails: adaptive threshold only.

    Returns (boxes, "adaptive threshold") if 9 valid regions are found, else ([], None).
    Caller should use :func:`_make_fallback_grid` when this returns empty boxes.
    """
    h_full, w_full = img_bgr.shape[:2]
    if max(h_full, w_full) > max_dim:
        scale_fb = max_dim / max(h_full, w_full)
        img = cv2.resize(
            img_bgr, None, fx=scale_fb, fy=scale_fb, interpolation=cv2.INTER_AREA,
        )
    else:
        img = img_bgr
    h, w = img.shape[:2]
    scale_back_x = w_orig / w if max(h_full, w_full) > max_dim else 1.0
    scale_back_y = h_orig / h if max(h_full, w_full) > max_dim else 1.0

    def _draw_and_save(boxes: List, label: str, used: bool = True) -> None:
        if not dbg:
            return
        vis = img_bgr.copy()
        thickness = max(2, min(w_orig, h_orig) // 400)
        colors = [
            (255, 0, 0), (0, 255, 0), (0, 0, 255),
            (255, 255, 0), (255, 0, 255), (0, 255, 255),
            (128, 0, 255), (255, 128, 0), (0, 255, 128),
        ]
        for i, box in enumerate(boxes):
            pts = np.array([
                [box[0], box[1]], [box[2], box[3]],
                [box[4], box[5]], [box[6], box[7]],
            ], dtype=np.int32)
            cv2.polylines(vis, [pts], True, colors[i % len(colors)], thickness)
            cx = int((box[0] + box[2] + box[4] + box[6]) / 4)
            cy = int((box[1] + box[3] + box[5] + box[7]) / 4)
            font_scale = max(0.5, min(w_orig, h_orig) / 800.0)
            cv2.putText(vis, str(i + 1), (cx - 15, cy + 5),
                        cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), max(1, thickness))
        color = (0, 255, 0) if used else (0, 0, 255)
        cv2.putText(vis, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2)
        dbg.save_image(vis, "08b_fallback_squares.png")

    boxes = _fallback_adaptive_threshold(img, w_orig, h_orig, scale_back_x, scale_back_y)
    if boxes:
        if dbg:
            dbg.log(f"  Fallback: adaptive threshold found 9 regions")
        _draw_and_save(boxes, "Fallback: adaptive threshold (9 regions)", used=True)
        return (boxes, "adaptive threshold")

    if dbg:
        dbg.log(f"  Fallback: adaptive threshold did not yield 9 regions; using grid")
        vis = img_bgr.copy()
        font_scale = max(0.7, min(w_orig, h_orig) / 500.0)
        (tw, th), _ = cv2.getTextSize("Fallback: no result (using grid)", cv2.FONT_HERSHEY_SIMPLEX, font_scale, 2)
        cv2.rectangle(vis, (5, 5), (tw + 25, th + 25), (0, 0, 0), -1)
        cv2.putText(vis, "Fallback: no result (using grid)", (10, 20 + th),
                    cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 255), 2)
        dbg.save_image(vis, "08b_fallback_squares.png")
    return ([], None)



def _downsample(
    img_bgr: np.ndarray, max_dim: int, dbg: DebugLogger,
) -> Tuple[np.ndarray, float]:
    """Stage 1: Downsample image to at most *max_dim* on its longest side."""
    h_orig, w_orig = img_bgr.shape[:2]
    if max(h_orig, w_orig) > max_dim:
        scale = max_dim / max(h_orig, w_orig)
        img_scaled = cv2.resize(
            img_bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA,
        )
    else:
        scale = 1.0
        img_scaled = img_bgr.copy()

    h, w = img_scaled.shape[:2]
    dbg.log(f"Original image size: {w_orig}x{h_orig}")
    dbg.log(f"\nStep 1: Downsampling")
    dbg.log(f"  Scaled image size: {w}x{h} (scale={scale:.3f})")
    dbg.save_image(img_scaled, "01_downsampled.png")
    return img_scaled, scale


def _denoise(img_scaled: np.ndarray, dbg: DebugLogger) -> np.ndarray:
    """Stage 2: Light Gaussian blur for denoising."""
    kernel = 5
    img_blurred = cv2.GaussianBlur(img_scaled, (kernel, kernel), 0)
    dbg.log(f"\nStep 2: Gaussian blur denoising")
    dbg.log(f"  Kernel size: {kernel}x{kernel}")
    dbg.save_image(img_blurred, "02_blurred.png")
    return img_blurred


def _segment_colors(
    img_blurred: np.ndarray,
    dbg: DebugLogger,
    k: int = 4,
    use_l: bool = False,
) -> Tuple[np.ndarray, int]:
    """Stage 3: K-means in LAB space, assign every pixel a cluster label.

    By default clusters on a,b channels only (chrominance).  When *use_l* is
    True, all three L,a,b channels are used (L scaled down by 0.5) to give
    better separation when piece colors are chromatically similar to the
    background surface.

    Returns (labels, k) where *labels* is an (H, W) int32 array.
    """
    h, w = img_blurred.shape[:2]
    img_lab = cv2.cvtColor(img_blurred, cv2.COLOR_BGR2LAB)

    ch_desc = "L,a,b" if use_l else "a,b"
    dbg.log(f"\nStep 3: Color segmentation (LAB {ch_desc} + K-means, k={k})")
    dbg.save_image(cv2.cvtColor(img_lab, cv2.COLOR_LAB2BGR), "03a_lab_converted.png")

    max_samples = min(200_000, h * w // 4)
    sample_lab = _downsample_pixels(img_lab, max_samples=max_samples)

    L_lower = np.percentile(sample_lab[:, 0], 1.0)
    L_upper = np.percentile(sample_lab[:, 0], 99.0)
    sample_lab = sample_lab[(sample_lab[:, 0] >= L_lower) & (sample_lab[:, 0] <= L_upper)]

    dbg.log(f"  Sampled {len(sample_lab)} pixels (after L* outlier rejection)")
    dbg.log(f"  L* range: [{L_lower:.1f}, {L_upper:.1f}]")

    if use_l:
        sample_feat = sample_lab.astype(np.float32).copy()
        sample_feat[:, 0] = (sample_feat[:, 0] - 128.0) * 0.5
        sample_feat[:, 1:3] -= 128.0
    else:
        sample_feat = sample_lab[:, 1:3].astype(np.float32) - 128.0
    n_feat = sample_feat.shape[1]

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.5)
    _, _labels_sample, centers = cv2.kmeans(
        sample_feat, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS,
    )
    centers = centers.astype(np.float32)

    dbg.log(f"  K-means clusters: {k}")
    dbg.log(f"  Cluster centers ({ch_desc} centered):")
    for i, c in enumerate(centers):
        dbg.log(f"    Cluster {i}: {', '.join(f'{v:.1f}' for v in c)}")

    cluster_stds = []
    for ci in range(k):
        pts = sample_feat[_labels_sample.flatten() == ci]
        if len(pts) > 1:
            cluster_stds.append([float(np.std(pts[:, j])) + 1e-6 for j in range(n_feat)])
        else:
            cluster_stds.append([10.0] * n_feat)
    cluster_stds = np.array(cluster_stds, dtype=np.float32)

    if use_l:
        px_lab = img_lab.reshape(-1, 3).astype(np.float32)
        px_feat = np.empty_like(px_lab)
        px_feat[:, 0] = (px_lab[:, 0] - 128.0) * 0.5
        px_feat[:, 1:3] = px_lab[:, 1:3] - 128.0
    else:
        px_feat = img_lab[:, :, 1:3].reshape(-1, 2).astype(np.float32) - 128.0

    n_pixels = px_feat.shape[0]
    min_dist = np.full(n_pixels, np.inf, dtype=np.float32)
    labels = np.zeros(n_pixels, dtype=np.int32)

    for ci in range(k):
        diff = (px_feat - centers[ci]) / cluster_stds[ci]
        dist = np.sqrt(np.sum(diff ** 2, axis=1))
        closer = dist < min_dist
        labels[closer] = ci
        min_dist[closer] = dist[closer]

    labels = labels.reshape(h, w)

    vis_colors = [
        (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0),
        (255, 0, 255), (0, 255, 255), (128, 128, 0), (128, 0, 128),
    ]
    cluster_vis = np.zeros((h, w, 3), dtype=np.uint8)
    for i in range(k):
        cluster_vis[labels == i] = vis_colors[i % len(vis_colors)]
    dbg.save_image(cluster_vis, "03b_kmeans_clusters.png")

    return labels, k


def _spatial_filter_foreground_mask(
    fg_mask: np.ndarray,
    dbg: DebugLogger,
) -> np.ndarray:
    """Remove K-means bleed artifacts from the union-of-foreground-clusters mask.

    After OR-ing every non-primary-background cluster, the same label can appear
    on both puzzle tiles and the table (e.g. cyan birds + cyan glare on green).
    This pass drops:

    - Tiny speckles (below a fractional area floor).
    - Small components that sit almost entirely in the image border ring
      (typical table/chroma noise).
    - Rare huge, non-compact blobs that hug the frame (texture wrongly merged
      with a tile color).

    If filtering would wipe most of the mask or leave too few components, the
    original mask is returned unchanged.
    """
    m = (fg_mask > 0).astype(np.uint8) * 255
    h, w = m.shape[:2]
    img_area = h * w
    orig_sum = int(m.sum() // 255)
    if orig_sum == 0:
        return fg_mask

    margin = max(4, int(min(h, w) * 0.055))
    border = np.zeros((h, w), dtype=bool)
    border[:margin, :] = True
    border[-margin:, :] = True
    border[:, :margin] = True
    border[:, -margin:] = True

    min_speck = max(100, int(img_area * 0.00032))
    min_substantial = max(450, int(img_area * 0.011))

    num_labels, labels_cc, stats, _ = cv2.connectedComponentsWithStats(
        m, connectivity=8,
    )

    keep = np.zeros(num_labels, dtype=bool)
    keep[0] = False
    dropped: List[str] = []

    for i in range(1, num_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_speck:
            dropped.append(f"CC{i}(speck,{area}px)")
            continue

        comp = labels_cc == i
        border_px = int(np.count_nonzero(comp & border))
        border_frac = border_px / max(1, area)

        if area < min_substantial and border_frac >= 0.84:
            dropped.append(f"CC{i}(edge,{area}px,bf={border_frac:.2f})")
            continue

        if area >= int(img_area * 0.19):
            comp_u8 = comp.astype(np.uint8) * 255
            contours, _ = cv2.findContours(
                comp_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
            )
            if contours:
                largest = max(contours, key=lambda c: float(cv2.contourArea(c)))
                ca = float(cv2.contourArea(largest))
                if ca > 1e-6:
                    rect = cv2.minAreaRect(largest)
                    (_cx, _cy), (rw, rh), _ = rect
                    rw, rh = max(1e-6, rw), max(1e-6, rh)
                    aspect = max(rw, rh) / min(rw, rh)
                    hull = cv2.convexHull(largest)
                    hull_area = float(cv2.contourArea(hull))
                    solidity = ca / hull_area if hull_area > 1e-6 else 1.0
                    bx, by, bw, bh = (
                        stats[i, cv2.CC_STAT_LEFT],
                        stats[i, cv2.CC_STAT_TOP],
                        stats[i, cv2.CC_STAT_WIDTH],
                        stats[i, cv2.CC_STAT_HEIGHT],
                    )
                    touches = (
                        bx <= 2
                        or by <= 2
                        or bx + bw >= w - 3
                        or by + bh >= h - 3
                    )
                    if touches and aspect > 2.55 and solidity < 0.82:
                        dropped.append(
                            f"CC{i}(bleed,{area}px,a={aspect:.2f},sol={solidity:.2f})"
                        )
                        continue

        keep[i] = True

    new_sum = sum(
        int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, num_labels) if keep[i]
    )
    n_kept = int(keep.sum())

    # Revert only if we would wipe the mask or remove almost everything.
    if n_kept == 0 or new_sum < int(0.045 * max(1, orig_sum)):
        dbg.log(
            f"  Spatial FG filter skipped (kept {n_kept} CCs, "
            f"{new_sum}/{orig_sum}px — too aggressive)"
        )
        return fg_mask

    out = np.zeros_like(m)
    for i in range(1, num_labels):
        if keep[i]:
            out[labels_cc == i] = 255

    if dropped:
        dbg.log(
            f"  Spatial FG filter: dropped {len(dropped)} component(s): "
            f"{'; '.join(dropped[:6])}{'…' if len(dropped) > 6 else ''}"
        )
    dbg.log(
        f"  Spatial FG filter: {orig_sum}px → {int(out.sum() // 255)}px "
        f"({n_kept} components kept)"
    )
    return out


def _identify_foreground(
    img_scaled: np.ndarray,
    img_blurred: np.ndarray,
    labels: np.ndarray,
    k: int,
    dbg: DebugLogger,
) -> np.ndarray:
    """Stage 4: Determine which cluster is background via multi-signal scoring.

    Scores each K-means cluster by three signals:
      - Saturation: backgrounds tend to be desaturated
      - Periphery dominance: backgrounds occupy areas closer to image edges
      - Color variance: backgrounds tend to have low within-cluster variance

    Periphery dominance uses a continuous distance-from-edge weighting across
    ALL pixels (not a thin border strip), making it robust to tight crops.

    Signals are rank-normalized across clusters then combined with fixed weights.

    Returns (fg_mask, bg_clusters) where fg_mask is a binary mask (uint8,
    0/255) built from the primary background cluster, and bg_clusters is a
    list of all background-like cluster indices (used for gap carving).
    """
    h, w = labels.shape

    # Saturation signal
    img_hsv = cv2.cvtColor(img_blurred, cv2.COLOR_BGR2HSV)
    saturation = img_hsv[:, :, 1].astype(np.float32) / 255.0

    # Periphery dominance signal
    xs = np.minimum(np.arange(w, dtype=np.float32),
                    np.arange(w, dtype=np.float32)[::-1])
    ys = np.minimum(np.arange(h, dtype=np.float32),
                    np.arange(h, dtype=np.float32)[::-1])
    edge_dist = np.minimum(xs[None, :], ys[:, None])
    max_dist = edge_dist.max()
    if max_dist > 0:
        edge_dist /= max_dist

    periph_vis = (edge_dist * 255).astype(np.uint8)
    periph_vis = cv2.applyColorMap(periph_vis, cv2.COLORMAP_VIRIDIS)
    dbg.save_image(periph_vis, "04a_periphery_map.png")

    # Color variance signal in LAB space
    img_lab_f = cv2.cvtColor(img_blurred, cv2.COLOR_BGR2LAB).astype(np.float32)

    # Gather per-cluster statistics
    mean_sats: List[float] = []
    periph_means: List[float] = []
    color_stds: List[float] = []

    for ci in range(k):
        mask = labels == ci
        n = max(1, int(mask.sum()))

        mean_sats.append(float(np.mean(saturation[mask])))
        periph_means.append(float(np.mean(edge_dist[mask])))

        lab_px = img_lab_f[mask]
        color_stds.append(float(np.mean(np.std(lab_px, axis=0))) if n > 1 else 0.0)

    # Rank-normalize each signal to [0, 1] where 1 is most background-like.
    def _rank_normalize(values: List[float], invert: bool) -> np.ndarray:
        arr = np.array(values, dtype=np.float64)
        if invert:
            arr = -arr
        lo, hi = float(arr.min()), float(arr.max())
        if hi - lo < 1e-9:
            return np.full(len(values), 0.5)
        return (arr - lo) / (hi - lo)

    sat_scores = _rank_normalize(mean_sats, invert=True)       # low sat -> bg
    periph_scores = _rank_normalize(periph_means, invert=True)  # near edges -> bg
    var_scores = _rank_normalize(color_stds, invert=True)       # low variance -> bg

    W_SAT, W_PERIPH, W_VAR = 0.40, 0.35, 0.25
    combined = W_SAT * sat_scores + W_PERIPH * periph_scores + W_VAR * var_scores

    bg_cluster = int(np.argmax(combined))

    # Identify all background-like clusters: any cluster whose score is
    # above the midpoint between the strongest bg and strongest fg signals.
    # These extra clusters are used for gap-carving during blob splitting
    # (Strategy 0) but NOT for the main foreground mask, keeping it
    # conservative.
    score_mid = (float(combined.max()) + float(combined.min())) / 2.0
    bg_clusters = [
        ci for ci in range(k) if combined[ci] >= score_mid
    ]
    if bg_cluster not in bg_clusters:
        bg_clusters.append(bg_cluster)

    # Log foreground scoring details.
    dbg.log(f"\nStep 4: Foreground identification (multi-signal scoring)")
    dbg.log(f"  Weights: saturation={W_SAT}, periphery={W_PERIPH}, color_variance={W_VAR}")
    dbg.log(f"  Cluster scoring (higher combined = more background-like):")
    for ci in range(k):
        bg_tag = " *BG*" if ci in bg_clusters else ""
        dbg.log(
            f"    Cluster {ci}: combined={combined[ci]:.3f} "
            f"(sat={sat_scores[ci]:.3f} [mean={mean_sats[ci]:.3f}], "
            f"periph={periph_scores[ci]:.3f} [mean_dist={periph_means[ci]:.3f}], "
            f"var={var_scores[ci]:.3f} [std={color_stds[ci]:.1f}]){bg_tag}"
        )
    dbg.log(f"  Primary background cluster: {bg_cluster}")
    dbg.log(f"  All background-like clusters (for carving): {bg_clusters}")

    # Union every cluster except the primary background, then strip obvious
    # chroma-bleed specks and border/table blobs (same label on tile + surface).
    fg_mask = np.zeros((h, w), dtype=np.uint8)
    fg_cluster_ids = [ci for ci in range(k) if ci != bg_cluster]
    for ci in fg_cluster_ids:
        fg_mask |= np.where(labels == ci, 255, 0).astype(np.uint8)
    dbg.log(
        f"  Foreground: union of clusters {fg_cluster_ids} "
        f"(exclude primary bg {bg_cluster})"
    )
    fg_mask = _spatial_filter_foreground_mask(fg_mask, dbg)
    fg_pct = fg_mask.sum() // 255
    dbg.log(f"  Foreground pixels: {fg_pct} ({fg_pct / (h * w):.1%} of image)")
    dbg.save_image(fg_mask, "04b_foreground_mask.png")
    return fg_mask, bg_clusters


def _clean_mask(fg_mask: np.ndarray, dbg: DebugLogger) -> np.ndarray:
    """Stage 5: Morphological cleanup — small close, per-component hole fill, open.

    Uses a small morph close (5x5) to connect tiny breaks within pieces
    without bridging the larger inter-piece gaps.  Then fills internal holes
    per-component: for each connected component, the outer contour is found
    and filled, which plugs all internal holes (where piece imagery matched
    the background cluster) while preserving gaps between separate components.
    """
    h, w = fg_mask.shape[:2]
    dbg.log(f"\nStep 5: Cleaning and solidifying mask")

    close_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, close_k)
    dbg.save_image(fg_mask, "05a_morph_close.png")

    num_cc, labels_cc, _, _ = cv2.connectedComponentsWithStats(fg_mask, connectivity=8)
    filled = np.zeros_like(fg_mask)
    for i in range(1, num_cc):
        comp_mask = (labels_cc == i).astype(np.uint8) * 255
        contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(filled, contours, -1, 255, -1)
    fg_mask = filled
    dbg.save_image(fg_mask, "05b_holes_filled.png")

    open_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, open_k)
    dbg.save_image(fg_mask, "05c_specks_removed.png")

    num_labels, labels_cc, stats, _ = cv2.connectedComponentsWithStats(fg_mask, connectivity=8)
    # Keep small-but-valid fragments that morph open may have separated (only drop tiny specks).
    min_comp_area = (h * w) * 0.002
    cleaned = np.zeros_like(fg_mask)
    kept = 0
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] >= min_comp_area:
            cleaned[labels_cc == i] = 255
            kept += 1
    fg_mask = cleaned

    dbg.log(f"  Removed {num_labels - 1 - kept} small components")
    dbg.log(f"  Kept {kept} components")
    dbg.save_image(fg_mask, "05d_small_removed.png")
    return fg_mask


def _find_components(
    fg_mask: np.ndarray,
    img_scaled: np.ndarray,
    dbg: DebugLogger,
) -> List[np.ndarray]:
    """Stage 6: Connected components as boolean masks, filtered by area and shape."""
    h, w = fg_mask.shape[:2]
    img_area = h * w
    dbg.log(f"\nStep 6: Finding components")

    num_labels, labels_cc, stats, _ = cv2.connectedComponentsWithStats(
        fg_mask, connectivity=8,
    )

    expected_piece = img_area / 9.0
    min_area = max(expected_piece * 0.08, img_area * 0.0015)
    max_area = min(expected_piece * 10.0, img_area * 0.92)

    components: List[np.ndarray] = []
    for i in range(1, num_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area or area > max_area:
            continue
        comp = labels_cc == i
        aspect, _solid = _component_squareness(comp)
        if aspect > 4.5:
            continue
        components.append(comp.astype(bool))

    components.sort(key=lambda m: int(m.sum()), reverse=True)

    dbg.log(
        f"  {len(components)} components pass filters "
        f"(area [{min_area:.0f}, {max_area:.0f}] px, aspect ≤ 4.5)"
    )
    if components:
        dbg.save_image(
            _colorize_components((h, w), components, base_img=img_scaled),
            "06a_components.png",
        )
    else:
        dbg.log(f"  No components passed filters")
        dbg.save_image(img_scaled, "06a_components.png")

    return components


def _predict_missing_grid_pos(
    existing_masks: List[np.ndarray],
) -> Optional[Tuple[float, float]]:
    """Predict the centroid of the missing piece in a 3x3 grid.

    Given 8 component masks (one grid cell missing), clusters their
    centroids into 3 rows and 3 columns, finds the unoccupied cell,
    and returns its predicted (x, y) centroid.
    """
    if len(existing_masks) < 6:
        return None

    centroids = []
    for m in existing_masks:
        ys, xs = np.where(m)
        if len(xs) == 0:
            continue
        centroids.append((float(xs.mean()), float(ys.mean())))

    if len(centroids) < 6:
        return None

    def _cluster_3(values: List[float]) -> Optional[List[float]]:
        vals = sorted(values)
        if len(vals) < 6:
            return None
        gaps = [(vals[i + 1] - vals[i], i) for i in range(len(vals) - 1)]
        gaps.sort(reverse=True)
        if len(gaps) < 2:
            return None
        cuts = sorted([gaps[0][1], gaps[1][1]])
        groups = [vals[: cuts[0] + 1], vals[cuts[0] + 1 : cuts[1] + 1], vals[cuts[1] + 1 :]]
        return [float(np.mean(g)) for g in groups]

    col_centers = _cluster_3([c[0] for c in centroids])
    row_centers = _cluster_3([c[1] for c in centroids])
    if col_centers is None or row_centers is None:
        return None

    piece_side = float(np.sqrt(np.median([m.sum() for m in existing_masks])))
    tol = piece_side * 0.5

    for ry in row_centers:
        for cx in col_centers:
            occupied = any(
                abs(c[0] - cx) < tol and abs(c[1] - ry) < tol
                for c in centroids
            )
            if not occupied:
                return (cx, ry)

    return None


def _trim_oversized_blob(
    blob_mask: np.ndarray,
    expected_area: float,
    existing_masks: List[np.ndarray],
    dbg: DebugLogger,
) -> np.ndarray:
    """Trim an oversized single-piece blob by removing background seepage.

    Two strategies are applied in sequence:

    1. **Grid-cell clipping** \u2014 The 8 valid components define a 3\u00d73 grid.
       The missing cell is predicted and the blob is clipped to a tight
       region around that cell, removing seepage that extends toward image
       edges or corners.

    2. **Progressive erosion** \u2014 If the blob is still oversized after
       clipping, progressive erosion peels off remaining thin protrusions.
       The best surviving component (scored by area proximity and
       squareness) is dilated back within the clipped blob boundary.
    """
    h, w = blob_mask.shape[:2]
    piece_side = int(np.sqrt(expected_area))

    # Strategy 1: grid-cell clipping
    trimmed = blob_mask
    predicted = _predict_missing_grid_pos(existing_masks)
    if predicted is not None:
        cx, cy = predicted
        half = int(piece_side * 0.7)

        clip_x0 = max(0, int(cx) - half)
        clip_x1 = min(w, int(cx) + half)
        clip_y0 = max(0, int(cy) - half)
        clip_y1 = min(h, int(cy) + half)

        clipped = blob_mask.copy()
        clipped[:clip_y0, :] = False
        clipped[clip_y1:, :] = False
        clipped[:, :clip_x0] = False
        clipped[:, clip_x1:] = False

        clipped_area = int(clipped.sum())
        dbg.log(
            f"      Trim grid-cell clip at ({cx:.0f},{cy:.0f}): "
            f"{int(blob_mask.sum())}px \u2192 {clipped_area}px "
            f"(expected ~{expected_area:.0f})"
        )
        trimmed = clipped

    trimmed_area = int(trimmed.sum())
    if trimmed_area <= expected_area * 1.5:
        return trimmed

    # Strategy 2: progressive erosion
    blob_u8 = trimmed.astype(np.uint8) * 255

    best_component: Optional[np.ndarray] = None
    best_score = float("inf")
    best_erode = 0

    for erode_size in range(3, 50, 2):
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (erode_size, erode_size),
        )
        eroded = cv2.erode(blob_u8, kernel)

        n_cc, labels_cc, stats_cc, _ = cv2.connectedComponentsWithStats(
            eroded, connectivity=8,
        )
        if n_cc <= 1:
            break

        for i in range(1, n_cc):
            area = stats_cc[i, cv2.CC_STAT_AREA]
            w_c = stats_cc[i, cv2.CC_STAT_WIDTH]
            h_c = stats_cc[i, cv2.CC_STAT_HEIGHT]
            aspect = max(w_c, h_c) / max(1, min(w_c, h_c))

            area_ratio = area / expected_area
            if area_ratio < 0.15:
                continue

            area_penalty = abs(area_ratio - 1.0)
            aspect_penalty = max(0.0, aspect - 1.5)
            score = area_penalty + 0.3 * aspect_penalty

            if score < best_score:
                best_score = score
                best_component = labels_cc == i
                best_erode = erode_size

    if best_component is None:
        dbg.log(f"      Trim erosion: could not isolate core, keeping clipped blob")
        return trimmed

    seed_u8 = best_component.astype(np.uint8) * 255
    recover_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (best_erode, best_erode),
    )
    recovered = cv2.dilate(seed_u8, recover_kernel)
    result = (recovered > 0) & trimmed

    recovered_area = int(result.sum())
    dbg.log(
        f"      Trim erosion: erode k={best_erode} \u2192 core, dilate back \u2192 "
        f"{recovered_area}px (expected ~{expected_area:.0f})"
    )
    return result


def _watershed_topology_relief(blob_u8: np.ndarray) -> np.ndarray:
    """3-channel relief from distance transform + gradient for marker watershed.

    Boundaries follow geometric ridges (narrow necks between lobes), not RGB
    edges — robust when the bridge matches both pieces in color.
    """
    dist = cv2.distanceTransform(blob_u8, cv2.DIST_L2, 5)
    dn = cv2.normalize(dist, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    gx = cv2.Sobel(dist, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(dist, cv2.CV_32F, 0, 1, ksize=3)
    gm = np.sqrt(gx * gx + gy * gy)
    gn = cv2.normalize(gm, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    return cv2.merge([dn, gn, dn])


def _extract_watershed_regions(
    markers_ws: np.ndarray,
    n_seeds: int,
    blob_mask: np.ndarray,
    min_area: int,
) -> List[np.ndarray]:
    """Pull boolean masks for labels 1..n_seeds after watershed."""
    result: List[np.ndarray] = []
    for i in range(1, n_seeds + 1):
        m = (markers_ws == i) & blob_mask
        if int(m.sum()) >= min_area:
            result.append(m)
    return result


def _split_blob(
    blob_mask: np.ndarray,
    n_target: int,
    img_scaled: np.ndarray,
    dbg: DebugLogger,
    labels: Optional[np.ndarray] = None,
    bg_clusters: Optional[List[int]] = None,
) -> List[np.ndarray]:
    """Split a single merged foreground blob into *n_target* pieces.

    0. **Background-cluster carving** + watershed (RGB then topology fallback).

    1. **Progressive erosion** seeds + watershed (RGB then topology).

    1.5 **Morphological opening** — if a thin bridge disconnects under a small
        open, use those cores as seeds + **topology watershed** on the full blob.

    2. **Distance-transform peaks** with a *small* peak-merge kernel so two
        adjacent squares keep two maxima; watershed **topology first**, then RGB.

    Topology watershed uses distance + Sobel relief so cuts follow the neck
    between lobes even when the passage matches both pieces in color.
    """
    h, w = blob_mask.shape[:2]
    blob_u8 = blob_mask.astype(np.uint8) * 255
    blob_area = int(blob_mask.sum())
    min_seed_area = max(80, int(blob_area * 0.015))
    min_piece_guess = blob_area / max(n_target, 2)
    min_keep = max(min_seed_area, int(min_piece_guess * 0.08))

    relief_topo = _watershed_topology_relief(blob_u8)

    def _watershed_dual(
        markers: np.ndarray, n_seeds: int, log_note: str,
    ) -> List[np.ndarray]:
        """Try RGB image watershed, then topology relief if split is weak."""
        m = markers.copy()
        ws = cv2.watershed(img_scaled, m)
        res = _extract_watershed_regions(ws, n_seeds, blob_mask, min_keep)
        if len(res) >= 2:
            return res
        m2 = markers.copy()
        ws2 = cv2.watershed(relief_topo, m2)
        res2 = _extract_watershed_regions(ws2, n_seeds, blob_mask, min_keep)
        if len(res2) >= 2:
            dbg.log(f"      {log_note}: topology relief split OK ({len(res2)} regions)")
            return res2
        return res if res else res2

    # Strategy 0: background-cluster carving
    # Remove bg-cluster pixels from the blob so the gap lines between pieces
    # (which were bridged by morphological close) reappear.  A small
    # morphological open widens the carved gaps (often only 1-2px at
    # downsampled resolution), and 4-connectivity ensures diagonal touching
    # doesn't re-merge them.
    if labels is not None and bg_clusters:
        bg_mask = np.zeros_like(blob_mask, dtype=bool)
        for bci in bg_clusters:
            bg_mask |= (labels == bci)
        carved = blob_mask & ~bg_mask
        carved_u8 = carved.astype(np.uint8) * 255
        # Widen the carved gaps with a small open
        open_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        carved_u8 = cv2.morphologyEx(carved_u8, cv2.MORPH_OPEN, open_k)
        n_cc, labels_cc, stats_cc, _ = cv2.connectedComponentsWithStats(
            carved_u8, connectivity=4,
        )
        valid_ids = [
            i for i in range(1, n_cc)
            if stats_cc[i, cv2.CC_STAT_AREA] > min_seed_area
        ]
        if len(valid_ids) >= 2:
            n_use = min(len(valid_ids), n_target)
            valid_ids.sort(
                key=lambda vi: int(stats_cc[vi, cv2.CC_STAT_AREA]),
                reverse=True,
            )
            markers = np.zeros((h, w), dtype=np.int32)
            for mid, ci in enumerate(valid_ids[:n_use], start=1):
                markers[labels_cc == ci] = mid
            result = _watershed_dual(markers, n_use, "BG-carve")
            if len(result) >= 2:
                dbg.log(
                    f"      BG-cluster carving -> "
                    f"{len(valid_ids)} fragments -> {len(result)} regions"
                )
                return result

    # Strategy 1: progressive erosion
    # Accept any >= 2 seeds.  Prefer the first level that gives >= n_target;
    # if we never reach n_target, use the best partial split we found.
    best_erosion: Optional[Tuple[int, int, np.ndarray]] = None
    for erode_size in range(3, 40, 2):
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (erode_size, erode_size),
        )
        eroded = cv2.erode(blob_u8, kernel)

        n_cc, labels_cc, stats_cc, _ = cv2.connectedComponentsWithStats(
            eroded, connectivity=8,
        )

        valid_ids = [
            i for i in range(1, n_cc)
            if stats_cc[i, cv2.CC_STAT_AREA] > min_seed_area
        ]

        if len(valid_ids) >= n_target:
            markers = np.zeros((h, w), dtype=np.int32)
            for mid, ci in enumerate(valid_ids[:n_target], start=1):
                markers[labels_cc == ci] = mid
            result = _watershed_dual(markers, n_target, f"Erosion k={erode_size}")
            if len(result) >= 2:
                dbg.log(
                    f"      Erosion (k={erode_size}) \u2192 "
                    f"{len(valid_ids)} seeds \u2192 {len(result)} regions"
                )
                return result

        if len(valid_ids) >= 2:
            if best_erosion is None or len(valid_ids) > best_erosion[1]:
                markers = np.zeros((h, w), dtype=np.int32)
                for mid, ci in enumerate(valid_ids, start=1):
                    markers[labels_cc == ci] = mid
                best_erosion = (erode_size, len(valid_ids), markers)

        if len(valid_ids) <= 1 and erode_size > 5:
            break

    if best_erosion is not None:
        erode_size, n_seeds, markers = best_erosion
        result = _watershed_dual(markers, n_seeds, f"Erosion partial k={erode_size}")
        if len(result) >= 2:
            dbg.log(
                f"      Erosion (k={erode_size}) \u2192 "
                f"{n_seeds} seeds \u2192 {len(result)} regions (partial)"
            )
            return result

    # Strategy 1.5: small opening disconnects thin bridges
    piece_side = float(np.sqrt(blob_area / max(n_target, 2)))
    for k in (3, 5, 7, 9, 11):
        if k > max(5, int(piece_side * 0.22)):
            break
        se = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        opened = cv2.morphologyEx(blob_u8, cv2.MORPH_OPEN, se)
        n_op, lab_op, st_op, _ = cv2.connectedComponentsWithStats(
            opened, connectivity=8,
        )
        valid_op = [
            i for i in range(1, n_op)
            if st_op[i, cv2.CC_STAT_AREA] >= min_seed_area
        ]
        if len(valid_op) < n_target:
            continue
        valid_op.sort(
            key=lambda vi: int(st_op[vi, cv2.CC_STAT_AREA]), reverse=True,
        )
        markers = np.zeros((h, w), dtype=np.int32)
        for mid, vi in enumerate(valid_op[:n_target], start=1):
            markers[lab_op == vi] = mid
        result_op = _watershed_dual(markers, n_target, f"Open k={k}")
        if len(result_op) >= 2:
            dbg.log(
                f"      Morph open {k}x{k} \u2192 {len(valid_op)} cores \u2192 "
                f"{len(result_op)} regions"
            )
            return result_op

    # Strategy 2: distance-transform local maxima fallback
    dbg.log(
        f"      Erosion/open could not separate, distance-transform peaks"
    )
    dist = cv2.distanceTransform(blob_u8, cv2.DIST_L2, 5)
    max_val = float(np.max(dist))
    if max_val == 0:
        return [blob_mask]

    piece_radius = float(np.sqrt(blob_area / max(n_target, 2) / np.pi))
    # Small kernel keeps separate peaks on adjacent squares; large kernel merges them.
    kernel_size = max(3, min(21, int(piece_radius * 0.35)))
    if kernel_size % 2 == 0:
        kernel_size += 1

    dilated = cv2.dilate(dist, np.ones((kernel_size, kernel_size), np.uint8))
    local_max = (dist == dilated) & (dist > max_val * 0.12) & blob_mask

    n_peaks, peak_labels, _, peak_centroids = cv2.connectedComponentsWithStats(
        local_max.astype(np.uint8), connectivity=8,
    )

    if n_peaks <= 1:
        dbg.log(f"      No local maxima found, cannot split")
        return [blob_mask]

    peaks = []
    for i in range(1, n_peaks):
        pmask = peak_labels == i
        peaks.append((i, float(dist[pmask].max()), peak_centroids[i]))
    peaks.sort(key=lambda x: int(x[1]), reverse=True)

    selected = peaks[:n_target]
    if len(selected) < 2:
        dbg.log(f"      Only 1 usable peak, cannot split")
        return [blob_mask]

    markers = np.zeros((h, w), dtype=np.int32)
    dil_pt = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for mid, (_, _, centroid) in enumerate(selected, start=1):
        cx, cy = int(centroid[0]), int(centroid[1])
        markers[cy, cx] = mid
    # Expand point seeds slightly so watershed has stable basins
    for mid in range(1, len(selected) + 1):
        layer = (markers == mid).astype(np.uint8)
        if int(layer.sum()) <= 4:
            layer = cv2.dilate(layer, dil_pt)
            markers[(layer > 0) & (markers == 0)] = mid

    n_mark = len(selected)
    result_fb = _watershed_dual(markers, n_mark, "DT peaks")
    dbg.log(
        f"      Distance-transform (peak kernel {kernel_size}) \u2192 "
        f"{len(result_fb)} regions"
    )
    return result_fb if result_fb else [blob_mask]


def _component_squareness(mask: np.ndarray) -> Tuple[float, float]:
    """Return (aspect_ratio, solidity) for a component mask. Lower aspect = more square."""
    m = mask.astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return float("inf"), 0.0
    largest = max(contours, key=lambda c: float(cv2.contourArea(c)))
    rect = cv2.minAreaRect(largest)
    (_cx, _cy), (rw, rh), _angle = rect
    rw, rh = max(1e-6, rw), max(1e-6, rh)
    aspect = max(rw, rh) / min(rw, rh)
    hull = cv2.convexHull(largest)
    hull_area = cv2.contourArea(hull)
    area = cv2.contourArea(largest)
    solidity = area / hull_area if hull_area > 0 else 1.0
    return aspect, solidity


def _is_near_border_and_non_square(
    mask: np.ndarray, h: int, w: int, aspect: float, solidity: float,
) -> bool:
    """True if component is both close to the image border and non-square (reject as piece)."""
    margin_frac = 0.15
    margin = min(h, w) * margin_frac
    m = mask.astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False
    largest = max(contours, key=lambda c: float(cv2.contourArea(c)))
    mom = cv2.moments(largest)
    if mom["m00"] == 0:
        return False
    cx = mom["m10"] / mom["m00"]
    cy = mom["m01"] / mom["m00"]
    dist_to_edge = min(cx, cy, w - 1 - cx, h - 1 - cy)
    near_border = dist_to_edge < margin
    non_square = aspect > 1.5 or solidity < 0.68
    return near_border and non_square


def _enforce_nine_regions(
    fg_mask: np.ndarray,
    component_masks: List[np.ndarray],
    img_scaled: np.ndarray,
    dbg: DebugLogger,
    labels: Optional[np.ndarray] = None,
    bg_clusters: Optional[List[int]] = None,
) -> List[np.ndarray]:
    """Stage 7: Ensure exactly 9 component masks, splitting or pruning as needed.

    When too few components are found, identifies foreground regions not covered
    by any existing component and splits merged blobs individually using
    watershed.  Already-valid components are preserved.

    When *labels* and *bg_clusters* are provided, background-like K-means
    clusters are used to carve gap lines inside merged blobs before erosion.
    """
    h, w = fg_mask.shape[:2]
    dbg.log(f"\nStep 7: Enforcing exactly 9 regions")

    # When we have too many, keep the 9 most square-like (real pieces are square;
    # background blobs are irregular). Exclude components that are near border AND
    # non-square (border slivers / cropped background) so they are not chosen.
    if len(component_masks) > 9:
        n_orig = len(component_masks)
        scored = [
            (*_component_squareness(m), i, m) for i, m in enumerate(component_masks)
        ]
        # Reject near-border + non-square; prefer to pick from the rest.
        valid_idxs = [
            i for i, (asp, sol, _, _) in enumerate(scored)
            if not _is_near_border_and_non_square(scored[i][3], h, w, asp, sol)
        ]
        if len(valid_idxs) >= 9:
            # Sort valid by aspect ascending, then area descending; take first 9.
            valid_scored = [scored[j] for j in valid_idxs]
            valid_scored.sort(key=lambda x: (x[0], -int(x[3].sum())))
            component_masks = [valid_scored[i][3] for i in range(9)]
            dbg.log(
                f"  Too many components ({n_orig} > 9), keeping 9 most square-like "
                f"(excluding {n_orig - len(valid_idxs)} near-border non-square)"
            )
        else:
            scored.sort(key=lambda x: (x[0], -int(x[3].sum())))
            component_masks = [scored[i][3] for i in range(9)]
            dbg.log(
                f"  Too many components ({n_orig} > 9), keeping 9 most square-like"
            )

    # When we have exactly 9, drop one only if it is clearly non-square (likely background).
    # Do not drop for "near border + non-square" here — that can remove valid edge pieces.
    if len(component_masks) == 9:
        aspects_solids = [_component_squareness(m) for m in component_masks]
        worst_idx = max(
            range(9),
            key=lambda i: (aspects_solids[i][0], -aspects_solids[i][1]),
        )
        worst_aspect, worst_solidity = aspects_solids[worst_idx]
        if worst_aspect > 1.7 and worst_solidity < 0.65:
            dbg.log(
                f"  Dropping component {worst_idx + 1} (aspect={worst_aspect:.2f}, "
                f"solidity={worst_solidity:.2f}) \u2014 likely background"
            )
            component_masks = [
                m for i, m in enumerate(component_masks) if i != worst_idx
            ]

    if len(component_masks) < 9:
        needed = 9 - len(component_masks)
        dbg.log(f"  Have {len(component_masks)}, need {needed} more \u2014 analyzing uncovered foreground")

        covered = np.zeros((h, w), dtype=bool)
        for m in component_masks:
            covered |= m
        uncovered = (fg_mask > 0) & ~covered
        uncovered_u8 = uncovered.astype(np.uint8) * 255

        dbg.log(f"  Uncovered foreground: {int(uncovered.sum())} pixels")
        dbg.save_image(uncovered_u8, "07a_uncovered.png")

        if uncovered.sum() > 0:
            existing_areas = [int(m.sum()) for m in component_masks]
            expected_area = float(np.median(existing_areas)) if existing_areas else 1.0

            n_blobs, blob_labels, blob_stats, _ = cv2.connectedComponentsWithStats(
                uncovered_u8, connectivity=8,
            )

            min_blob_area = expected_area * 0.3
            extra: List[np.ndarray] = []

            # Sort blobs largest-first so real pieces are picked before noise
            blob_indices = list(range(1, n_blobs))
            blob_indices.sort(
                key=lambda bi: int(blob_stats[bi, cv2.CC_STAT_AREA]), reverse=True,
            )

            for bi in blob_indices:
                blob = blob_labels == bi
                blob_area = int(blob.sum())

                if blob_area < min_blob_area:
                    dbg.log(f"    Blob {bi}: {blob_area}px \u2014 too small, skipping")
                    continue

                n_target = max(1, round(blob_area / expected_area))
                n_target = min(n_target, needed - len(extra))
                if n_target <= 0:
                    break

                if n_target == 1:
                    if blob_area > expected_area * 1.5:
                        dbg.log(
                            f"    Blob {bi}: {blob_area}px \u2248 1 piece but "
                            f"{blob_area / expected_area:.1f}x expected \u2014 trimming"
                        )
                        extra.append(_trim_oversized_blob(
                            blob, expected_area, component_masks, dbg,
                        ))
                    else:
                        extra.append(blob)
                        dbg.log(f"    Blob {bi}: {blob_area}px \u2248 1 piece, keeping whole")
                else:
                    dbg.log(f"    Blob {bi}: {blob_area}px \u2248 {n_target} pieces, splitting")
                    split = _split_blob(
                        blob, n_target, img_scaled, dbg,
                        labels=labels, bg_clusters=bg_clusters,
                    )
                    extra.extend(split)

            # Recursive splitting: if any result piece is still oversized,
            # split it again until we reach 9 or can't split further.
            max_rounds = 5
            for _round in range(max_rounds):
                if len(component_masks) + len(extra) >= 9:
                    break
                still_needed = 9 - len(component_masks) - len(extra)
                if still_needed <= 0:
                    break
                resplit: List[np.ndarray] = []
                kept: List[np.ndarray] = []
                for em in extra:
                    em_area = int(em.sum())
                    if em_area > expected_area * 1.5 and still_needed > 0:
                        sub_n = max(2, min(
                            round(em_area / expected_area),
                            still_needed + 1,
                        ))
                        dbg.log(
                            f"    Re-split: {em_area}px \u2248 {sub_n} pieces"
                        )
                        sub = _split_blob(
                            em, sub_n, img_scaled, dbg,
                            labels=labels, bg_clusters=bg_clusters,
                        )
                        if len(sub) > 1:
                            resplit.extend(sub)
                            still_needed -= (len(sub) - 1)
                        else:
                            kept.append(em)
                    else:
                        kept.append(em)
                extra = kept + resplit
                if not resplit:
                    break

            component_masks.extend(extra)

            if extra:
                dbg.save_image(
                    _colorize_components((h, w), extra),
                    "07b_split_result.png",
                )

    # Merged pieces: 8 components can still cover 100% of fg — uncovered is empty.
    # Split oversized masks (area >> median piece) until we have 9 or nothing fits.
    if len(component_masks) < 9:
        non_empty = [m for m in component_masks if int(m.sum()) > 0]
        if non_empty:
            expected_area = float(np.median([int(m.sum()) for m in non_empty]))
        else:
            expected_area = max(1.0, (h * w) / 9.0)
        dbg.log(
            f"  Still {len(component_masks)} regions — try splitting merged components "
            f"(expected_area ~{expected_area:.0f}px)"
        )
        max_merge_rounds = 12
        for _round in range(max_merge_rounds):
            if len(component_masks) >= 9:
                break
            areas = [int(m.sum()) for m in component_masks]
            if not areas or max(areas) < expected_area * 1.32:
                dbg.log(
                    f"  No component large enough to split "
                    f"(max {max(areas) if areas else 0}px vs {expected_area * 1.32:.0f}px thresh)"
                )
                break
            idx = int(np.argmax(areas))
            big = component_masks.pop(idx)
            big_area = int(big.sum())
            need_more = 9 - len(component_masks)
            n_target = max(2, min(round(big_area / expected_area), need_more + 1))
            dbg.log(
                f"  Splitting merged component (~{big_area}px) into {n_target} parts "
                f"(round {_round + 1})"
            )
            split = _split_blob(
                big, n_target, img_scaled, dbg,
                labels=labels, bg_clusters=bg_clusters,
            )
            if len(split) > 1:
                component_masks.extend(split)
                dbg.save_image(
                    _colorize_components((h, w), split, base_img=img_scaled),
                    "07b_split_merged.png",
                )
            else:
                component_masks.insert(idx, big)
                dbg.log(f"  Split failed to separate; restoring component")
                break

    while len(component_masks) < 9:
        component_masks.append(np.zeros((h, w), dtype=bool))

    component_masks = component_masks[:9]
    dbg.log(f"  Final component count: {len(component_masks)}")
    dbg.save_image(
        _colorize_components((h, w), component_masks, base_img=img_scaled),
        "07c_final_components.png",
    )
    return component_masks


def _prune_detached_satellite_ccs(
    mask: np.ndarray,
    expected_side: float,
) -> np.ndarray:
    """Keep the main tile body; drop smaller 8-connected blobs that sit far away.

    K-means can assign the same label to a puzzle tile and a chroma patch on the
    table. Those appear as a second connected component. Merging is not applied
    when the satellite is clearly separated (train / cyan corner case).
    """
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) == 0:
        return mask

    n_lab, labels_cc, stats, centroids = cv2.connectedComponentsWithStats(
        m, connectivity=8,
    )
    if n_lab <= 2:
        return mask

    order = sorted(
        range(1, n_lab),
        key=lambda i: int(stats[i, cv2.CC_STAT_AREA]),
        reverse=True,
    )
    main = order[0]
    main_area = int(stats[main, cv2.CC_STAT_AREA])
    mc = centroids[main]

    keep = np.zeros_like(m)
    keep[labels_cc == main] = 1

    sep_thresh = max(12.0, float(expected_side) * 0.62)

    for i in order[1:]:
        a = int(stats[i, cv2.CC_STAT_AREA])
        if a < max(48, int(main_area * 0.06)):
            continue
        c = centroids[i]
        dist = float(np.hypot(c[0] - mc[0], c[1] - mc[1]))
        # Second body comparable to the first (two lobes of one mask) — keep even if separated.
        if a >= int(main_area * 0.58):
            keep[labels_cc == i] = 1
            continue
        if dist <= sep_thresh:
            keep[labels_cc == i] = 1
        # else: drop detached satellite (e.g. same K-means label on table + tile)

    return keep.astype(bool)


def _component_near_another(
    component_masks: List[np.ndarray],
    index: int,
    expected_side: float,
    gap_frac: float = 0.18,
) -> bool:
    """True if this component's bbox is very close to any other component's bbox.

    Used to trigger cleaning: a jut can pull one piece's box toward a neighbor,
    so we try to remove protrusions when components are close.
    """
    mask = component_masks[index]
    if mask.sum() == 0:
        return False
    mask_u8 = mask.astype(np.uint8) * 255
    contours, _ = cv2.findContours(
        mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
    )
    if not contours:
        return False
    largest = max(contours, key=lambda c: float(cv2.contourArea(c)))
    x1, y1, w1, h1 = cv2.boundingRect(largest)
    r1 = x1 + w1
    b1 = y1 + h1
    gap_thresh = max(2.0, expected_side * gap_frac)

    for j, other in enumerate(component_masks):
        if j == index or other.sum() == 0:
            continue
        other_u8 = other.astype(np.uint8) * 255
        cnts, _ = cv2.findContours(
            other_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
        )
        if not cnts:
            continue
        large = max(cnts, key=lambda c: float(cv2.contourArea(c)))
        x2, y2, w2, h2 = cv2.boundingRect(large)
        r2 = x2 + w2
        b2 = y2 + h2
        # Separation between the two axis-aligned boxes (0 if overlapping)
        dx = max(0.0, x2 - r1, x1 - r2)
        dy = max(0.0, y2 - b1, y1 - b2)
        gap = float(np.sqrt(dx * dx + dy * dy))
        if gap < gap_thresh:
            return True
    return False


def _clean_component_shapes(
    component_masks: List[np.ndarray],
    img_scaled: np.ndarray,
    dbg: DebugLogger,
) -> List[np.ndarray]:
    """Stage 7b: Remove protrusions from irregularly shaped components.

    Phase 0 — Drop detached satellite blobs (same K-means label on tile + table).

    Phase 1 — Distance-transform erosion for *thin* protrusions.
    For components with low solidity or close to a neighbor (jut risk), a
    distance-transform approach peels off protrusions by thresholding interior
    distance, keeping the deepest core, then dilating back within the original mask.

    Phase 2 — Square-fit clipping for *thick* protrusions.
    Puzzle pieces are roughly square.  If a component's ``minAreaRect`` aspect
    ratio is still > 1.25 after Phase 1, or its area is > 1.4× the median,
    the mask is clipped to a rotated square of the expected piece size.  The
    square is centred on the deepest interior point (distance-transform max)
    and oriented using the core's ``minAreaRect`` angle, so protrusions cannot
    pull the centre or rotation off.
    """
    areas = [int(m.sum()) for m in component_masks if m.sum() > 0]
    if not areas:
        return component_masks

    expected_area = float(np.median(areas))
    expected_side = float(np.sqrt(expected_area))
    h, w = component_masks[0].shape[:2]

    cleaned: List[np.ndarray] = []
    n_fixed_p1 = 0

    for i, mask in enumerate(component_masks):
        area = int(mask.sum())
        if area == 0:
            cleaned.append(mask)
            continue

        mask = _prune_detached_satellite_ccs(mask, expected_side)
        area = int(mask.sum())
        if area == 0:
            cleaned.append(mask)
            continue

        mask_u8 = mask.astype(np.uint8) * 255
        contours, _ = cv2.findContours(
            mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
        )
        if not contours:
            cleaned.append(mask)
            continue

        largest = max(contours, key=lambda c: float(cv2.contourArea(c)))
        hull = cv2.convexHull(largest)
        hull_area = cv2.contourArea(hull)
        solidity = cv2.contourArea(largest) / hull_area if hull_area > 0 else 1.0

        rect = cv2.minAreaRect(largest)
        (_cx, _cy), (rw, rh), _angle = rect
        rect_area = max(1e-6, rw * rh)
        fill_ratio = cv2.contourArea(largest) / rect_area

        bx, by, bw, bh = cv2.boundingRect(largest)
        aspect = max(bw, bh) / max(1, min(bw, bh))

        near_neighbor = _component_near_another(
            component_masks, i, expected_side, gap_frac=0.18,
        )

        # Skip when already almost square/solid and not squeezed against a neighbor.
        # Slightly stricter than before so we do not carve holey hummingbird art.
        if solidity >= 0.84 and aspect <= 1.33 and not near_neighbor:
            cleaned.append(mask)
            continue

        # Concave / holey masks without neighbor pressure: DT cleaning often
        # shrinks valid area (dark plumage holes read as "fragmented").
        if not near_neighbor and solidity < 0.86 and fill_ratio < 0.82:
            dbg.log(
                f"    Component {i+1}: holey art (solidity={solidity:.2f}, "
                f"fill={fill_ratio:.2f}) \u2014 skip Phase 1"
            )
            cleaned.append(mask)
            continue

        if near_neighbor:
            dbg.log(
                f"    Component {i+1}: close to neighbor \u2014 cleaning protrusions"
            )

        # Only clean when the component mostly fills its minAreaRect ("square + offshoot").
        # Stricter floor: more fragmented masks skip (hummingbirds).
        if fill_ratio < 0.76:
            dbg.log(
                f"    Component {i+1}: fill_ratio={fill_ratio:.2f} (< 0.76), "
                f"skip (fragmented piece, not square+offshoot)"
            )
            cleaned.append(mask)
            continue

        dbg.log(
            f"    Component {i+1}: solidity={solidity:.2f}, aspect={aspect:.2f}, "
            f"fill={fill_ratio:.2f} \u2014 cleaning protrusions"
        )

        dist = cv2.distanceTransform(mask_u8, cv2.DIST_L2, 5)
        max_dist = float(dist.max())

        best_thresh = 0
        best_score = float("inf")
        best_idx = -1

        for thresh in range(1, int(max_dist * 0.5) + 1, 2):
            core = (dist >= thresh).astype(np.uint8) * 255

            n_cc, labels_cc, stats_cc, _ = cv2.connectedComponentsWithStats(
                core, connectivity=8,
            )
            if n_cc <= 1:
                break

            cc_items = [
                (j, stats_cc[j, cv2.CC_STAT_AREA]) for j in range(1, n_cc)
            ]
            cc_items.sort(key=lambda x: int(x[1]), reverse=True)
            idx, comp_area = cc_items[0]

            if comp_area < expected_area * 0.4:
                break

            w_c = stats_cc[idx, cv2.CC_STAT_WIDTH]
            h_c = stats_cc[idx, cv2.CC_STAT_HEIGHT]
            comp_aspect = max(w_c, h_c) / max(1, min(w_c, h_c))

            area_penalty = abs(comp_area / expected_area - 1.0)
            aspect_penalty = max(0.0, comp_aspect - 1.2) * 2.0
            score = area_penalty + aspect_penalty

            if score < best_score:
                best_score = score
                best_thresh = thresh
                best_idx = idx

        if best_thresh > 0 and best_idx > 0:
            core = (dist >= best_thresh).astype(np.uint8) * 255
            n_cc, labels_cc, _, _ = cv2.connectedComponentsWithStats(
                core, connectivity=8,
            )
            seed = (labels_cc == best_idx).astype(np.uint8) * 255
            kern_sz = 2 * best_thresh + 1
            kern = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (kern_sz, kern_sz),
            )
            recovered = cv2.dilate(seed, kern)
            best_result = (recovered > 0) & mask
            new_area = int(best_result.sum())

            # Don't apply if we would remove too much (carving into valid piece).
            if new_area < area * 0.75:
                dbg.log(
                    f"      Cleaned result would remove too much "
                    f"({area}px \u2192 {new_area}px), keeping original"
                )
                cleaned.append(mask)
            else:
                # Only accept when the result is clearly a solid shape (offshoot removed),
                # not a carved-up fragment. Fragmented pieces yield low solidity after erosion.
                res_contours, _ = cv2.findContours(
                    best_result.astype(np.uint8) * 255,
                    cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
                )
                res_solidity = 1.0
                if res_contours:
                    res_largest = max(res_contours, key=lambda c: float(cv2.contourArea(c)))
                    res_hull = cv2.convexHull(res_largest)
                    res_hull_area = cv2.contourArea(res_hull)
                    if res_hull_area > 0:
                        res_solidity = cv2.contourArea(res_largest) / res_hull_area
                if res_solidity < 0.88:
                    dbg.log(
                        f"      Cleaned result solidity={res_solidity:.2f} (< 0.88), "
                        f"keeping original (would carve fragment)"
                    )
                    cleaned.append(mask)
                else:
                    n_fixed_p1 += 1
                    dbg.log(f"      Cleaned: {area}px \u2192 {new_area}px")
                    cleaned.append(best_result)
        else:
            cleaned.append(mask)

    if n_fixed_p1 > 0:
        dbg.log(f"  Phase 1: fixed {n_fixed_p1} component(s) via erosion")

    n_fixed_p2 = 0

    for i, mask in enumerate(cleaned):
        area = int(mask.sum())
        if area == 0:
            continue

        mask_u8 = mask.astype(np.uint8) * 255
        contours, _ = cv2.findContours(
            mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
        )
        if not contours:
            continue

        largest = max(contours, key=lambda c: float(cv2.contourArea(c)))
        hull2 = cv2.convexHull(largest)
        ha2 = cv2.contourArea(hull2)
        solidity2 = cv2.contourArea(largest) / ha2 if ha2 > 0 else 1.0

        rect = cv2.minAreaRect(largest)
        (_cx, _cy), (rw, rh), _angle = rect
        rect_aspect = max(rw, rh) / max(1.0, min(rw, rh))
        rect_area2 = max(1e-6, rw * rh)
        fill_ratio2 = cv2.contourArea(largest) / rect_area2

        # Holey / concave artwork: square clipping often bites real piece area.
        if solidity2 < 0.89 or fill_ratio2 < 0.78:
            continue

        # How much bigger is this component's bounding rectangle than
        # expected?  Protrusions enlarge the diagonal; internal holes don't.
        expected_diag = expected_side * 1.4142
        rect_diag = float(np.sqrt(rw ** 2 + rh ** 2))
        diag_ratio = rect_diag / expected_diag if expected_diag > 0 else 1.0

        area_ratio = area / expected_area

        # Slightly harder to trigger than before — fewer false clips on art-heavy tiles.
        needs_clip = (
            rect_aspect > 1.28
            or area_ratio > 1.42
            or diag_ratio > 1.24
        )

        if not needs_clip:
            continue

        dbg.log(
            f"    Component {i+1}: Phase 2 triggered "
            f"(rect_aspect={rect_aspect:.2f}, area_ratio={area_ratio:.2f}, "
            f"diag_ratio={diag_ratio:.2f})"
        )

        dist = cv2.distanceTransform(mask_u8, cv2.DIST_L2, 5)

        # Deepest interior point = true piece centre (unaffected by protrusions)
        _, _, _, max_loc = cv2.minMaxLoc(dist)
        core_cx, core_cy = float(max_loc[0]), float(max_loc[1])

        # Core angle: erode to ~40% of max distance, fit minAreaRect on core
        max_d = float(dist.max())
        core_thresh = max_d * 0.4
        core_mask = (dist >= core_thresh).astype(np.uint8) * 255
        core_contours, _ = cv2.findContours(
            core_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
        )
        if core_contours:
            core_largest = max(core_contours, key=lambda c: float(cv2.contourArea(c)))
            (_, _), (_, _), core_angle = cv2.minAreaRect(core_largest)
        else:
            core_angle = _angle

        clip_side = expected_side * 1.25
        clip_rect_pts = cv2.boxPoints(
            ((core_cx, core_cy), (clip_side, clip_side), core_angle),
        )
        clip_mask = np.zeros_like(mask_u8)
        cv2.fillPoly(clip_mask, [clip_rect_pts.astype(np.int32)], 255)

        new_mask = mask & (clip_mask > 0)
        new_area = int(new_mask.sum())

        # Skip if clip would leave too little (must keep a valid piece size).
        if new_area < expected_area * 0.5:
            dbg.log(
                f"      square-clip would remove too much "
                f"({area}px \u2192 {new_area}px), skipping"
            )
            continue
        # When not oversized, don't remove too much of component (avoid cutting art).
        # When oversized (area_ratio > 1.42), the extra is likely offshoot — allow clip.
        if area_ratio <= 1.42 and new_area < area * 0.72:
            dbg.log(
                f"      square-clip would remove >28% of component "
                f"({area}px \u2192 {new_area}px), skipping"
            )
            continue

        dbg.log(
            f"      square-clipped {area}px \u2192 {new_area}px"
        )
        cleaned[i] = new_mask
        n_fixed_p2 += 1

    if n_fixed_p2 > 0:
        dbg.log(f"  Phase 2: clipped {n_fixed_p2} component(s) to square fit")

    n_total = n_fixed_p1 + n_fixed_p2
    if n_total > 0:
        dbg.log(f"  Total: fixed {n_total} component shape(s)")
        dbg.save_image(
            _colorize_components((h, w), cleaned, base_img=img_scaled),
            "07d_cleaned_components.png",
        )

    return cleaned


def _fit_bounding_boxes(
    component_masks: List[np.ndarray],
    scale: float,
    orig_shape: Tuple[int, int],
    dbg: DebugLogger,
) -> List[Tuple[float, float, float, float, float, float, float, float]]:
    """Stage 8: Fit an oriented bounding box to each component mask.

    Returns boxes in original-image coordinates.
    """
    h_orig, w_orig = orig_shape
    dbg.log(f"\nStep 8: Fitting bounding boxes")

    boxes: List[Tuple[float, float, float, float, float, float, float, float]] = []
    for mask in component_masks:
        mask_u8 = mask.astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if not contours:
            boxes.append((0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0))
            continue

        largest = max(contours, key=lambda c: float(cv2.contourArea(c)))

        peri = cv2.arcLength(largest, True)
        approx = cv2.approxPolyDP(largest, 0.02 * peri, True)

        if 4 <= len(approx) <= 20:
            refined = approx
        else:
            hull = cv2.convexHull(largest)
            if len(hull) >= 4:
                refined = cv2.approxPolyDP(hull, 0.01 * cv2.arcLength(hull, True), True)
            else:
                refined = largest

        rect = cv2.minAreaRect(refined)
        corners = cv2.boxPoints(rect)
        corners = order_points(corners)

        if scale != 1.0:
            corners = corners / scale

        corners = np.clip(corners, [0, 0], [w_orig - 1, h_orig - 1])
        boxes.append((
            float(corners[0][0]), float(corners[0][1]),
            float(corners[1][0]), float(corners[1][1]),
            float(corners[2][0]), float(corners[2][1]),
            float(corners[3][0]), float(corners[3][1]),
        ))

    return boxes


def _fit_edge_line(
    contour_pts: np.ndarray,
    p1: np.ndarray,
    p2: np.ndarray,
    strip_half_width: float = 30.0,
    edge_extend_frac: float = 0.1,
    min_pts: int = 20,
) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, float]]:
    """Fit a line to points within a strip around edge p1->p2.

    Selects points in a strip centered on the edge, then fits with Huber and
    iterative outlier rejection so humps/protrusions do not pull the line.
    Returns (point_on_line, direction_vector, inlier_points, mean_residual)
    or None.
    """
    edge_vec = p2 - p1
    edge_len = float(np.linalg.norm(edge_vec))
    if edge_len < 1:
        return None

    edge_dir = edge_vec / edge_len
    edge_normal = np.array([-edge_dir[1], edge_dir[0]])

    delta = contour_pts - p1
    proj_along = delta @ edge_dir
    proj_perp = delta @ edge_normal

    extend = edge_len * edge_extend_frac
    in_strip = (
        (proj_along > -extend) & (proj_along < edge_len + extend)
        & (np.abs(proj_perp) < strip_half_width)
    )

    strip_pts = contour_pts[in_strip].astype(np.float64)
    if len(strip_pts) < min_pts:
        return None

    # Iterative outlier rejection: humps/protrusions have large perpendicular
    # distance from the true edge; refit excluding them.
    max_iterations = 3
    outlier_median_mult = 2.0  # drop points beyond this * median residual
    min_inlier_frac = 0.5      # keep at least this fraction of points per iteration

    inliers = np.ones(len(strip_pts), dtype=bool)
    for _ in range(max_iterations):
        pts = strip_pts[inliers]
        if len(pts) < min_pts:
            break
        line = cv2.fitLine(
            pts.reshape(-1, 1, 2).astype(np.float32),
            cv2.DIST_HUBER, 0, 0.01, 0.01,
        )
        vx, vy, x0, y0 = line.flatten()
        fitted_pt = np.array([x0, y0], dtype=np.float64)
        fitted_normal = np.array([-vy, vx], dtype=np.float64)
        perp_dists = np.abs((strip_pts - fitted_pt) @ fitted_normal)
        med = float(np.median(perp_dists))
        if med < 1e-6:
            break
        threshold = max(outlier_median_mult * med, 1.0)
        # Don't discard more than (1 - min_inlier_frac) in one go
        if np.sum(perp_dists <= threshold) < len(strip_pts) * min_inlier_frac:
            threshold = float(np.percentile(perp_dists, 100 * min_inlier_frac))
        new_inliers = perp_dists <= threshold
        if np.sum(new_inliers) == np.sum(inliers):
            break
        inliers = new_inliers

    pts = strip_pts[inliers]
    if len(pts) < min_pts:
        return None
    line = cv2.fitLine(
        pts.reshape(-1, 1, 2).astype(np.float32),
        cv2.DIST_HUBER, 0, 0.01, 0.01,
    )
    vx, vy, x0, y0 = line.flatten()
    fitted_pt = np.array([x0, y0], dtype=np.float64)
    fitted_dir = np.array([vx, vy], dtype=np.float64)
    fitted_normal = np.array([-vy, vx], dtype=np.float64)
    perp_dists = np.abs((pts - fitted_pt) @ fitted_normal)
    mean_residual = float(np.mean(perp_dists))
    return (fitted_pt, fitted_dir, pts, mean_residual)


def _extract_strip(
    img: np.ndarray,
    p1: np.ndarray,
    p2: np.ndarray,
    strip_half_width: float,
    edge_extend_frac: float,
) -> Optional[Tuple[np.ndarray, np.ndarray, int, int]]:
    """Warp the image strip along edge p1->p2 to a rectangle.

    Returns (strip_img BGR, Minv for strip->crop coords, x_min, y_min)
    so image_coords = perspectiveTransform(pts_strip, Minv) + [x_min, y_min].
    Returns None if strip is degenerate.
    """
    edge_vec = p2 - p1
    edge_len = float(np.linalg.norm(edge_vec))
    if edge_len < 1:
        return None
    edge_dir = edge_vec / edge_len
    edge_normal = np.array([-edge_dir[1], edge_dir[0]])
    extend = edge_len * edge_extend_frac

    c1 = p1 - extend * edge_dir - strip_half_width * edge_normal
    c2 = p1 - extend * edge_dir + strip_half_width * edge_normal
    c3 = p2 + extend * edge_dir + strip_half_width * edge_normal
    c4 = p2 + extend * edge_dir - strip_half_width * edge_normal
    src_quad = np.array([c1, c2, c3, c4], dtype=np.float32)

    dst_w = max(2, int(edge_len + 2 * extend))
    dst_h = max(2, int(2 * strip_half_width))
    dst_quad = np.array(
        [[0, 0], [0, dst_h], [dst_w, dst_h], [dst_w, 0]],
        dtype=np.float32,
    )
    pad = 5
    x_min = max(0, int(src_quad[:, 0].min()) - pad)
    y_min = max(0, int(src_quad[:, 1].min()) - pad)
    x_max = min(img.shape[1], int(src_quad[:, 0].max()) + pad + 1)
    y_max = min(img.shape[0], int(src_quad[:, 1].max()) + pad + 1)
    if x_max <= x_min or y_max <= y_min:
        return None
    crop = img[y_min:y_max, x_min:x_max]
    src_quad_crop = (src_quad - np.array([x_min, y_min], dtype=np.float32)).astype(
        np.float32
    )
    src_quad_crop = np.ascontiguousarray(src_quad_crop.reshape(4, 2))
    dst_quad = np.ascontiguousarray(dst_quad.reshape(4, 2))

    M = cv2.getPerspectiveTransform(src_quad_crop, dst_quad)
    strip_img = cv2.warpPerspective(crop, M, (dst_w, dst_h))
    Minv = cv2.getPerspectiveTransform(dst_quad, src_quad_crop)
    return (strip_img, Minv, x_min, y_min)


def _find_edge_points_via_strip(
    img: np.ndarray,
    p1: np.ndarray,
    p2: np.ndarray,
    strip_half_width: float,
    edge_extend_frac: float,
    min_pts: int = 12,
    mask: Optional[np.ndarray] = None,
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """Find the piece edge in a warped strip using per-column gradient peaks.

    Warps the actual image (not just the mask) into a rectangle aligned with
    edge p1->p2.  In this rectangle the piece boundary runs roughly horizontal.
    For each column we compute the vertical gradient magnitude (across LAB
    channels) and take the row with the strongest transition — that is the
    piece-to-background boundary.

    The mask (optional) is used to determine which side of the strip is piece
    vs background and to restrict the search to the central band where the
    boundary actually is.

    Returns (edge_pts in image coords for fitting, strip_vis BGR for debug).
    """
    out = _extract_strip(img, p1, p2, strip_half_width, edge_extend_frac)
    if out is None:
        return None, None
    strip_img, Minv, x_min, y_min = out
    h, w = strip_img.shape[:2]
    if h < 6 or w < 6:
        return None, None

    lab = cv2.cvtColor(strip_img, cv2.COLOR_BGR2LAB).astype(np.float64)
    lab = cv2.GaussianBlur(lab, (5, 5), 1.0)

    # Combined gradient magnitude across L, a, b channels
    grad_mag = np.zeros((h, w), dtype=np.float64)
    for ch in range(3):
        gy = cv2.Sobel(lab[:, :, ch], cv2.CV_64F, 0, 1, ksize=3)
        grad_mag += gy * gy
    grad_mag = np.sqrt(grad_mag)

    # Restrict search to central band (avoid warp artifacts at edges).
    # The true boundary should be near the middle of the strip since
    # the strip is centred on the approximate edge.
    margin = max(3, h // 5)
    grad_mag[:margin, :] = 0
    grad_mag[h - margin:, :] = 0

    # Per-column: row of strongest vertical gradient
    peak_rows = np.argmax(grad_mag, axis=0)
    peak_strengths = grad_mag[peak_rows, np.arange(w)]

    # Reject weak columns — threshold at 20% of median so we keep more columns;
    # robust line fit in _fit_edge_line will drop hump-dominated columns.
    med_strength = float(np.median(peak_strengths[peak_strengths > 0])) if np.any(peak_strengths > 0) else 0
    strength_thresh = max(med_strength * 0.2, 1.0)
    valid = peak_strengths > strength_thresh

    cols = np.arange(w, dtype=np.float32)[valid]
    rows = peak_rows[valid].astype(np.float32)

    # Debug vis: strip image with detected boundary points in green
    strip_vis = strip_img.copy()
    for c_i, r_i in zip(cols.astype(int), rows.astype(int)):
        cv2.circle(strip_vis, (c_i, r_i), 1, (0, 255, 0), -1)

    if len(cols) < min_pts:
        return None, strip_vis

    # Map strip (col, row) back to image coordinates
    pts_strip = np.column_stack([cols, rows]).reshape(-1, 1, 2)
    pts_crop = cv2.perspectiveTransform(pts_strip, Minv)
    pts_img = pts_crop.reshape(-1, 2) + np.array([x_min, y_min])
    pts_img = pts_img.astype(np.float64)
    return pts_img, strip_vis


def _intersect_lines(
    p1: np.ndarray,
    d1: np.ndarray,
    p2: np.ndarray,
    d2: np.ndarray,
) -> Optional[np.ndarray]:
    """Intersect two 2D lines (point + direction). Returns point or None."""
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cross) < 1e-10:
        return None
    dp = p2 - p1
    t = (dp[0] * d2[1] - dp[1] * d2[0]) / cross
    return p1 + t * d1


def _refine_corners(
    boxes: List[Tuple[float, ...]],
    component_masks: List[np.ndarray],
    img_scaled: np.ndarray,
    img_original: np.ndarray,
    scale: float,
    orig_shape: Tuple[int, int],
    dbg: DebugLogger,
) -> List[Tuple[float, float, float, float, float, float, float, float]]:
    """Stage 9: Refine corners via edge-line fitting at higher resolution.

    For each piece, fits lines along its 4 edges by running a light two-region
    segmentation in each edge strip (find the dividing line), then intersects
    adjacent lines to derive refined corner positions. Falls back to contour
    points from the mask when strip segmentation yields too few boundary points.
    """
    h_orig, w_orig = orig_shape
    dbg.log(f"\nStep 9: Refining corners via edge-line fitting")

    max_refine_dim = 1800
    long_side = max(h_orig, w_orig)
    refine_ratio = min(max_refine_dim / long_side, 1.0)
    refine_w = int(w_orig * refine_ratio)
    refine_h = int(h_orig * refine_ratio)
    img_refine = cv2.resize(
        img_original, (refine_w, refine_h), interpolation=cv2.INTER_AREA,
    )
    dbg.log(f"  Refinement image: {refine_w}x{refine_h} (ratio={refine_ratio:.3f})")

    strip_half_width = 30.0
    edge_extend_frac = 0.1

    edge_pairs = [(0, 1), (1, 2), (2, 3), (3, 0)]

    refined_boxes: List[Tuple[float, ...]] = []
    debug_pieces: list = []

    for i, box in enumerate(boxes):
        corners_orig = np.array([
            [box[0], box[1]], [box[2], box[3]],
            [box[4], box[5]], [box[6], box[7]],
        ], dtype=np.float32)
        corners_orig = order_points(corners_orig)
        corners_ref = corners_orig * refine_ratio

        mask = component_masks[i] if i < len(component_masks) else None
        if mask is None or mask.sum() == 0:
            refined_boxes.append(box)
            continue

        mask_ref_u8 = cv2.resize(
            mask.astype(np.uint8) * 255,
            (refine_w, refine_h),
            interpolation=cv2.INTER_LINEAR,
        )
        mask_ref_u8 = cv2.GaussianBlur(mask_ref_u8, (3, 3), 0)
        _, mask_ref_u8 = cv2.threshold(mask_ref_u8, 127, 255, cv2.THRESH_BINARY)

        margin = int(strip_half_width + 20)
        xs, ys = corners_ref[:, 0], corners_ref[:, 1]
        rx0 = max(0, int(xs.min()) - margin)
        ry0 = max(0, int(ys.min()) - margin)
        rx1 = min(refine_w, int(xs.max()) + margin)
        ry1 = min(refine_h, int(ys.max()) + margin)

        piece_mask = mask_ref_u8[ry0:ry1, rx0:rx1].copy()

        # Morphological close to bridge internal holes/channels that reach
        # the piece edge — prevents contour dips from distorting edge fits.
        # Safe because each mask only contains one piece (no merging risk).
        close_sz = max(5, min(int(min(rx1 - rx0, ry1 - ry0) * 0.05), 25))
        if close_sz % 2 == 0:
            close_sz += 1
        close_kern = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (close_sz, close_sz),
        )
        piece_mask = cv2.morphologyEx(piece_mask, cv2.MORPH_CLOSE, close_kern)

        contours, _ = cv2.findContours(
            piece_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE,
        )
        if not contours:
            refined_boxes.append(box)
            dbg.log(f"  Piece {i+1}: no contour, keeping original")
            continue

        contour = max(contours, key=lambda c: float(cv2.contourArea(c)))
        contour_pts = contour.reshape(-1, 2).astype(np.float64)
        contour_pts[:, 0] += rx0
        contour_pts[:, 1] += ry0

        # Per-edge: fit line using contour points in strip, or mask-boundary-in-strip
        # (no k=2). Use whichever gives lower residual. Track source for debug.
        strip_vis_list: List[Optional[np.ndarray]] = []
        edge_source: List[str] = []  # "contour" or "strip" per edge
        max_residual = strip_half_width * 0.25
        max_residual_confident = 5.0

        fitted_lines: List[Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, float]]] = []
        for ei, (i1, i2) in enumerate(edge_pairs):
            strip_pts_img, strip_vis = _find_edge_points_via_strip(
                img_refine,
                corners_ref[i1],
                corners_ref[i2],
                strip_half_width,
                edge_extend_frac,
            )
            strip_vis_list.append(strip_vis)
            fit_contour = _fit_edge_line(
                contour_pts, corners_ref[i1], corners_ref[i2],
                strip_half_width, edge_extend_frac,
            )
            fit_strip = (
                _fit_edge_line(
                    strip_pts_img, corners_ref[i1], corners_ref[i2],
                    strip_half_width, edge_extend_frac,
                )
                if strip_pts_img is not None and len(strip_pts_img) >= 12
                else None
            )
            if fit_strip is not None and fit_contour is not None:
                if fit_strip[3] < fit_contour[3]:
                    result, src = fit_strip, "strip"
                else:
                    result, src = fit_contour, "contour"
            else:
                result = fit_contour if fit_contour is not None else fit_strip
                src = "strip" if (result is fit_strip) else "contour"
            edge_source.append(src)
            if result is not None:
                dbg.log(
                    f"    P{i+1} edge {i1+1}-{i2+1}: {src} (residual={result[3]:.1f}px)"
                )
            if result is not None and result[3] > max_residual:
                dbg.log(
                    f"      -> residual > {max_residual:.1f}px, skipping (poor fit)"
                )
                result = None
            fitted_lines.append(result)

        diag = float(np.linalg.norm(corners_orig[0] - corners_orig[2]))
        max_disp = min(diag * 0.08, 20.0 / scale)

        new_corners: List[np.ndarray] = []
        n_capped = 0
        n_low_confidence = 0
        for ci in range(4):
            prev_line = fitted_lines[(ci - 1) % 4]
            curr_line = fitted_lines[ci]

            if prev_line is not None and curr_line is not None:
                prev_res, curr_res = prev_line[3], curr_line[3]
                both_confident = (
                    prev_res <= max_residual_confident
                    and curr_res <= max_residual_confident
                )
                if not both_confident:
                    new_corners.append(corners_orig[ci])
                    n_low_confidence += 1
                    dbg.log(
                        f"    P{i+1} C{ci+1}: low confidence "
                        f"(residuals {prev_res:.1f}, {curr_res:.1f}px > "
                        f"{max_residual_confident:.1f}px), keeping original"
                    )
                    continue

                pt = _intersect_lines(
                    prev_line[0], prev_line[1],
                    curr_line[0], curr_line[1],
                )
                if pt is not None:
                    pt_orig = pt / refine_ratio
                    disp = float(np.linalg.norm(pt_orig - corners_orig[ci]))
                    if disp <= max_disp:
                        new_corners.append(pt_orig)
                    else:
                        new_corners.append(corners_orig[ci])
                        n_capped += 1
                        dbg.log(
                            f"    P{i+1} C{ci+1}: disp={disp:.1f}px > "
                            f"max={max_disp:.1f}px, reverted"
                        )
                else:
                    new_corners.append(corners_orig[ci])
            else:
                new_corners.append(corners_orig[ci])

        ref_arr = np.array(new_corners, dtype=np.float32)
        ref_arr = order_points(ref_arr)
        ref_arr = np.clip(ref_arr, [0, 0], [w_orig - 1, h_orig - 1])

        orig_arr = order_points(corners_orig)
        orig_area = float(cv2.contourArea(orig_arr.astype(np.float32)))
        ref_area = float(cv2.contourArea(ref_arr.astype(np.float32)))

        box_ok = True
        if orig_area > 0 and ref_area > 0:
            area_ratio = ref_area / orig_area
            if area_ratio < 0.65 or area_ratio > 1.5:
                box_ok = False

        if box_ok and ref_area > 0:
            for ci2 in range(4):
                p_prev = ref_arr[(ci2 - 1) % 4]
                p_curr = ref_arr[ci2]
                p_next = ref_arr[(ci2 + 1) % 4]
                va = p_prev - p_curr
                vb = p_next - p_curr
                la = float(np.linalg.norm(va))
                lb = float(np.linalg.norm(vb))
                if la < 1 or lb < 1:
                    box_ok = False
                    break
                cos_a = float(np.dot(va, vb) / (la * lb))
                angle_deg = float(np.degrees(np.arccos(np.clip(cos_a, -1, 1))))
                if angle_deg < 60 or angle_deg > 120:
                    box_ok = False
                    break

        n_fitted = sum(1 for fl in fitted_lines if fl is not None)
        if box_ok:
            refined_boxes.append((
                float(ref_arr[0][0]), float(ref_arr[0][1]),
                float(ref_arr[1][0]), float(ref_arr[1][1]),
                float(ref_arr[2][0]), float(ref_arr[2][1]),
                float(ref_arr[3][0]), float(ref_arr[3][1]),
            ))
            capped_str = f", {n_capped} capped" if n_capped > 0 else ""
            lc_str = f", {n_low_confidence} low-conf" if n_low_confidence > 0 else ""
            dbg.log(
                f"  Piece {i+1}: refined ({n_fitted}/4 edges fitted{capped_str}{lc_str})"
            )
        else:
            refined_boxes.append(box)
            dbg.log(f"  Piece {i+1}: validation failed ({n_fitted}/4 edges), keeping original")

        if dbg.enabled:
            debug_pieces.append((
                i, corners_ref, fitted_lines, piece_mask,
                rx0, ry0, box_ok,
                strip_vis_list,
                edge_source,
            ))

    # Debug: strip mask boundary per piece (2x2 = T,R,B,L) — mask warped to strip, not k=2
    if dbg.enabled and debug_pieces:
        cell_size = 200
        cols = min(3, len(debug_pieces))
        rows = (len(debug_pieces) + cols - 1) // cols
        strip_grid = np.zeros((rows * cell_size, cols * cell_size, 3), dtype=np.uint8)
        strip_grid[:] = 40
        edge_labels = ["T", "R", "B", "L"]
        for idx, piece_data in enumerate(debug_pieces):
            pi, c_ref, f_lines, pmask, rx0, ry0, ok = piece_data[:7]
            strip_vis_list = piece_data[7] if len(piece_data) > 7 else []
            r, c = idx // cols, idx % cols
            if strip_vis_list:
                sub_cell = cell_size // 2
                for ei, sv in enumerate(strip_vis_list):
                    er, ec = ei // 2, ei % 2
                    if sv is not None:
                        strip_grid[
                            r * cell_size + er * sub_cell : r * cell_size + (er + 1) * sub_cell,
                            c * cell_size + ec * sub_cell : c * cell_size + (ec + 1) * sub_cell,
                        ] = cv2.resize(sv, (sub_cell, sub_cell), interpolation=cv2.INTER_LINEAR)
                    cv2.putText(
                        strip_grid,
                        edge_labels[ei],
                        (c * cell_size + ec * sub_cell + 2, r * cell_size + er * sub_cell + 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1,
                    )
            cv2.putText(
                strip_grid, "P{}".format(pi + 1), (c * cell_size + 4, r * cell_size + 16),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1,
            )
        dbg.save_image(strip_grid, "09a_strip_segment.png")

    # Debug: edge-fitting visualization — green = contour fit, blue = strip (mask) fit
    if dbg.enabled and debug_pieces:
        cell_size = 200
        cols = min(3, len(debug_pieces))
        rows = (len(debug_pieces) + cols - 1) // cols
        grid = np.zeros((rows * cell_size, cols * cell_size, 3), dtype=np.uint8)

        for idx, piece_data in enumerate(debug_pieces):
            pi, c_ref, f_lines, pmask, rx0, ry0, ok = piece_data[:7]
            edge_source = piece_data[8] if len(piece_data) > 8 else []
            r, c = idx // cols, idx % cols
            ph, pw = pmask.shape[:2]

            display = cv2.resize(
                img_refine[ry0:ry0 + ph, rx0:rx0 + pw], (cell_size, cell_size),
            )
            sx = cell_size / pw
            sy = cell_size / ph

            mask_contours, _ = cv2.findContours(
                pmask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
            )
            for cnt in mask_contours:
                sc = (cnt.astype(np.float32) * np.array([sx, sy])).astype(np.int32)
                cv2.drawContours(display, [sc], -1, (0, 255, 255), 1)

            edge_names = ["T", "R", "B", "L"]
            for ei, (i1, i2) in enumerate(edge_pairs):
                lp1 = ((c_ref[i1] - [rx0, ry0]) * [sx, sy]).astype(np.int32)
                lp2 = ((c_ref[i2] - [rx0, ry0]) * [sx, sy]).astype(np.int32)
                cv2.line(display, tuple(lp1), tuple(lp2), (0, 0, 255), 1)

                fl = f_lines[ei]
                if fl is not None:
                    pt_on, d_vec, inliers, _residual = fl
                    pt_local = (pt_on - [rx0, ry0]) * [sx, sy]
                    d_scaled = d_vec * [sx, sy]
                    t_far = max(cell_size, cell_size) * 2
                    lp_a = (pt_local - t_far * d_scaled).astype(np.int32)
                    lp_b = (pt_local + t_far * d_scaled).astype(np.int32)
                    # Green = contour fit, Blue = strip (mask boundary) fit
                    line_color = (255, 0, 0) if (ei < len(edge_source) and edge_source[ei] == "strip") else (0, 255, 0)
                    cv2.line(display, tuple(lp_a), tuple(lp_b), line_color, 1)
                    src_label = edge_source[ei] if ei < len(edge_source) else "?"
                    cv2.putText(
                        display, src_label[0].upper(), (lp_a[0] + 2, lp_a[1] - 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1,
                    )

            if not ok:
                cv2.rectangle(display, (1, 1), (cell_size - 2, cell_size - 2), (0, 0, 255), 2)

            cv2.putText(
                display, f"P{pi+1}", (4, 16),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (255, 255, 255) if ok else (0, 100, 255), 1,
            )
            grid[r * cell_size:(r + 1) * cell_size, c * cell_size:(c + 1) * cell_size] = display

        dbg.save_image(grid, "09b_edge_fits.png")

    # Debug: red (original) vs green (refined) overlay
    vis = img_scaled.copy()
    for i, (orig, ref) in enumerate(zip(boxes, refined_boxes)):
        for box_tuple, color, thickness in [
            (orig, (0, 0, 255), 1), (ref, (0, 255, 0), 2),
        ]:
            if scale != 1.0:
                pts = np.array([
                    [box_tuple[0] * scale, box_tuple[1] * scale],
                    [box_tuple[2] * scale, box_tuple[3] * scale],
                    [box_tuple[4] * scale, box_tuple[5] * scale],
                    [box_tuple[6] * scale, box_tuple[7] * scale],
                ], dtype=np.int32)
            else:
                pts = np.array([
                    [box_tuple[0], box_tuple[1]], [box_tuple[2], box_tuple[3]],
                    [box_tuple[4], box_tuple[5]], [box_tuple[6], box_tuple[7]],
                ], dtype=np.int32)
            cv2.polylines(vis, [pts], True, color, thickness)

        if scale != 1.0:
            cx = int(np.mean([ref[j] * scale for j in range(0, 8, 2)]))
            cy = int(np.mean([ref[j] * scale for j in range(1, 8, 2)]))
        else:
            cx = int(np.mean([ref[j] for j in range(0, 8, 2)]))
            cy = int(np.mean([ref[j] for j in range(1, 8, 2)]))
        cv2.putText(
            vis, str(i + 1), (cx - 10, cy + 10),
            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2,
        )

    dbg.save_image(vis, "09_refined_corners.png")
    return refined_boxes


def _debug_visualize_result(
    img_scaled: np.ndarray,
    component_masks: List[np.ndarray],
    boxes: List[Tuple[float, ...]],
    scale: float,
    dbg: DebugLogger,
    fallback_source: Optional[str] = None,
) -> None:
    """Save the final debug visualization with contours and bounding boxes."""
    vis = img_scaled.copy()

    for mask in component_masks:
        mask_u8 = mask.astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            cv2.drawContours(vis, [max(contours, key=lambda c: float(cv2.contourArea(c)))], -1, (128, 128, 128), 1)

    for i, box in enumerate(boxes):
        if scale != 1.0:
            pts = np.array([
                [box[0] * scale, box[1] * scale], [box[2] * scale, box[3] * scale],
                [box[4] * scale, box[5] * scale], [box[6] * scale, box[7] * scale],
            ], dtype=np.int32)
        else:
            pts = np.array([
                [box[0], box[1]], [box[2], box[3]],
                [box[4], box[5]], [box[6], box[7]],
            ], dtype=np.int32)
        cv2.polylines(vis, [pts], True, (0, 255, 0), 2)
        cx, cy = int(np.mean(pts[:, 0])), int(np.mean(pts[:, 1]))
        cv2.putText(vis, str(i + 1), (cx - 10, cy + 10),
                     cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)

    if fallback_source:
        h_vis, w_vis = vis.shape[:2]
        label = f"Boxes from: {fallback_source}"
        font_scale = max(0.5, min(w_vis, h_vis) / 600.0)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 2)
        cv2.rectangle(vis, (5, 5), (tw + 20, th + 20), (0, 0, 0), -1)
        cv2.putText(vis, label, (10, 15 + th), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 255, 255), 2)

    dbg.save_image(vis, "08_initial_boxes.png")

    dbg.log(f"\n=== DEBUG COMPLETE ===")
    dbg.log(f"Debug images saved to: {dbg.debug_dir}/")
    dbg.log(f"  - 01_downsampled.png:         Downsampled image")
    dbg.log(f"  - 02_blurred.png:             After Gaussian blur")
    dbg.log(f"  - 03a_lab_converted.png:      LAB color space")
    dbg.log(f"  - 03b_kmeans_clusters.png:    K-means cluster visualization")
    dbg.log(f"  - 04a_border_sampling.png:    Border pixels sampled (green)")
    dbg.log(f"  - 04b_foreground_mask.png:    Foreground mask (white=foreground)")
    dbg.log(f"  - 05a_morph_close.png:        Morphological close (15x15)")
    dbg.log(f"  - 05b_holes_filled.png:       Holes filled")
    dbg.log(f"  - 05c_specks_removed.png:     Specks removed (morphological open)")
    dbg.log(f"  - 05d_small_removed.png:      Small components removed")
    dbg.log(f"  - 06a_components.png:         Valid components (colored overlay)")
    dbg.log(f"  - 07a_uncovered.png:          Uncovered foreground to split (if needed)")
    dbg.log(f"  - 07b_split_result.png:       Watershed-split sub-regions (if needed)")
    dbg.log(f"  - 07c_final_components.png:   Final 9 components (colored overlay)")
    dbg.log(f"  - 07d_cleaned_components.png: Shape-cleaned components (if protrusions found)")
    if fallback_source:
        dbg.log(f"  - 08_initial_boxes.png:       Bounding boxes (from fallback: {fallback_source})")
    else:
        dbg.log(f"  - 08_initial_boxes.png:       Initial bounding boxes (pre-refinement)")
    if fallback_source:
        dbg.log(f"  - 08b_fallback_squares.png:   Adaptive threshold attempt (or notice before grid)")
        dbg.log(f"  - 09* (strip/edge/refined):   Skipped when using fallback")
    else:
        dbg.log(f"  - 08b_fallback_squares.png:   (not written — validation passed, no fallback)")
        dbg.log(f"  - 09a_strip_segment.png:     Per-column gradient peaks in strip (T,R,B,L)")
        dbg.log(f"  - 09b_edge_fits.png:          Edge fits: green=contour, blue=strip (label C/S)")
        dbg.log(f"  - 09_refined_corners.png:     Local-crop refined corners (red=original, green=refined)")



def _run_pipeline_original(
    img_bgr: np.ndarray,
    max_dim: int,
    dbg: DebugLogger,
) -> List[Tuple[float, float, float, float, float, float, float, float]]:
    """Original pipeline: components -> enforce nine -> clean shapes -> boxes -> refine."""
    h_orig, w_orig = img_bgr.shape[:2]
    timer = PipelineTimer()

    with timer.step("1. Downsample"):
        img_scaled, scale = _downsample(img_bgr, max_dim, dbg)

    with timer.step("2. Denoise"):
        img_blurred = _denoise(img_scaled, dbg)

    with timer.step("3. Segment colors"):
        labels, k = _segment_colors(img_blurred, dbg)

    with timer.step("4. Identify foreground"):
        fg_mask, bg_clusters = _identify_foreground(img_scaled, img_blurred, labels, k, dbg)

    with timer.step("5. Clean mask"):
        fg_mask = _clean_mask(fg_mask, dbg)

    with timer.step("6. Find components"):
        components = _find_components(fg_mask, img_scaled, dbg)

    if len(components) < 3:
        dbg.log("\n--- Retry: too few components, re-clustering with L channel (k=6) ---")
        with timer.step("3R. Segment colors (retry)"):
            labels, k = _segment_colors(img_blurred, dbg, k=6, use_l=True)
        with timer.step("4R. Identify foreground (retry)"):
            fg_mask, bg_clusters = _identify_foreground(img_scaled, img_blurred, labels, k, dbg)
        with timer.step("5R. Clean mask (retry)"):
            fg_mask = _clean_mask(fg_mask, dbg)
        with timer.step("6R. Find components (retry)"):
            components = _find_components(fg_mask, img_scaled, dbg)

    if not components:
        timer.summary(dbg)
        return _make_fallback_grid(w_orig, h_orig)

    with timer.step("7. Enforce nine regions"):
        components = _enforce_nine_regions(
            fg_mask, components, img_scaled, dbg,
            labels=labels, bg_clusters=bg_clusters,
        )

    with timer.step("7b. Clean component shapes"):
        components = _clean_component_shapes(components, img_scaled, dbg)

    with timer.step("8. Fit bounding boxes"):
        boxes = _fit_bounding_boxes(components, scale, (h_orig, w_orig), dbg)

    with timer.step("8b. Validate"):
        errors = validate_bounding_boxes(boxes)
        use_fallback = False
        fallback_source: Optional[str] = None
        if errors:
            dbg.log(f"\n  VALIDATION FAILED:")
            for e in errors:
                dbg.log(f"    - {e}")
            dbg.log(f"  Trying fallbacks: adaptive threshold, then grid if needed...")
            square_boxes, fallback_method = _detect_squares_fallback(
                img_bgr, w_orig, h_orig,
                max_dim=500, dbg=dbg,
            )
            if square_boxes and not validate_bounding_boxes(square_boxes):
                dbg.log(f"  Using fallback: {fallback_method or 'unknown'}")
                boxes = square_boxes
                fallback_source = fallback_method or "fallback"
            else:
                if not square_boxes:
                    dbg.log(f"  Adaptive threshold did not produce a valid set; using grid")
                else:
                    dbg.log(f"  Adaptive threshold failed validation; using grid")
                boxes = _make_fallback_grid(w_orig, h_orig)
                fallback_source = "grid"
            use_fallback = True

    if use_fallback and fallback_source == "grid":
        dbg.log(f"\n  Skipping corner refinement (grid fallback has no edges to refine)")
    else:
        with timer.step("9. Refine corners"):
            boxes = _refine_corners(
                boxes, components, img_scaled, img_bgr,
                scale, (h_orig, w_orig), dbg,
            )

    with timer.step("Debug visualization"):
        _debug_visualize_result(
            img_scaled, components, boxes, scale, dbg,
            fallback_source=fallback_source,
        )

    timer.summary(dbg)
    dbg.log(f"  [ORIGINAL] Generated {len(boxes)} bounding boxes")
    return boxes



def detect_pieces(
    img_bgr: np.ndarray,
    max_dim: int = 800,
    debug: bool = False,
    debug_dir: str = "debug",
) -> List[Tuple[float, float, float, float, float, float, float, float]]:
    """Detect 9 puzzle pieces and return their bounding boxes.

    Args:
        img_bgr: Input image in BGR format.
        max_dim: Maximum dimension for downsampling.
        debug: If True, save intermediate images to *debug_dir*.
        debug_dir: Directory for debug images.

    Returns:
        List of 9 bounding-box tuples:
        (topLeft_x, topLeft_y, topRight_x, topRight_y,
         bottomRight_x, bottomRight_y, bottomLeft_x, bottomLeft_y)
    """
    dbg = DebugLogger(debug, debug_dir)
    return _run_pipeline_original(img_bgr, max_dim, dbg)
