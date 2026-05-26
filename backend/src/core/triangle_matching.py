"""Triangle matching: pair cluster representatives by color profile similarity.

Extracts LAB color histograms from each triangle's masked region, subtracts
the common background colors that appear across all triangles, then pairs
clusters by minimizing total histogram distance.

Pipeline:

1. Generate masks — threshold non-black pixels
2. Extract LAB color histograms (ab chrominance + L lightness)
3. IDF reweight — down-weight colors common across all triangles
4. Power-normalize — dampen quantity, emphasize color presence
5. Compute pairwise cosine distance (which colors, not how much)
6. Minimum-weight perfect matching (brute-force for n=8)
"""

from __future__ import annotations

import base64
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .debug import DebugLogger


AB_BINS = 16
L_BINS = 12
W_AB = 0.75
W_L = 0.25
POWER = 0.3  # power-law exponent to dampen quantity, emphasize presence



def generate_mask(img_bgr: np.ndarray, threshold: int = 8) -> np.ndarray:
    """Build a binary mask from a triangle image on a black background.

    Args:
        img_bgr: Triangle crop in BGR; non-black pixels are treated as foreground.
        threshold: Gray value above which pixels count as foreground.

    Returns:
        ``uint8`` mask with values 0 or 255, same spatial size as ``img_bgr``.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    return (gray > threshold).astype(np.uint8) * 255



def _extract_histograms(
    images: List[np.ndarray],
    masks: List[np.ndarray],
) -> Tuple[np.ndarray, np.ndarray]:
    """Extract L1-normalized LAB histograms. Returns (ab_hists, l_hists)."""
    ab_hists = []
    l_hists = []

    for img, mask in zip(images, masks):
        mask_u8 = (mask > 0).astype(np.uint8) * 255
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)

        ab = cv2.calcHist(
            [lab], [1, 2], mask_u8,
            [AB_BINS, AB_BINS], [0, 256, 0, 256],
        ).astype(np.float32).flatten()
        s = ab.sum()
        if s > 0:
            ab /= s

        l = cv2.calcHist(
            [lab], [0], mask_u8,
            [L_BINS], [0, 256],
        ).astype(np.float32).flatten()
        s = l.sum()
        if s > 0:
            l /= s

        ab_hists.append(ab)
        l_hists.append(l)

    return np.array(ab_hists), np.array(l_hists)


def _idf_reweight(hists: np.ndarray) -> np.ndarray:
    """Down-weight bins common across all triangles (IDF-style).

    Unlike median subtraction, this never zeros a bin — a green bird's
    green is kept, just down-weighted relative to its unique colors.
    """
    n = hists.shape[0]
    presence = (hists > 0.005).sum(axis=0).astype(np.float32)
    idf = np.log(1.0 + n / (1.0 + presence))
    weighted = hists * idf[np.newaxis, :]

    row_sums = weighted.sum(axis=1, keepdims=True)
    row_sums = np.maximum(row_sums, 1e-10)
    return weighted / row_sums


def _power_normalize(hists: np.ndarray) -> np.ndarray:
    """Apply power-law to emphasize color presence over quantity."""
    powered = np.power(hists, POWER)
    row_sums = powered.sum(axis=1, keepdims=True)
    row_sums = np.maximum(row_sums, 1e-10)
    return powered / row_sums



def _cosine_distance_matrix(hists: np.ndarray) -> np.ndarray:
    """Pairwise cosine distance — focuses on which colors are present,
    not how much of each."""
    norms = np.linalg.norm(hists, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    normed = hists / norms
    similarity = normed @ normed.T
    return 1.0 - np.clip(similarity, -1.0, 1.0).astype(np.float32)



def _matchings_recursive(items: List[int]):
    """Yield all perfect matchings as lists of (i, j) tuples."""
    if len(items) <= 1:
        yield []
        return

    first = items[0]
    rest = items[1:]

    for i, partner in enumerate(rest):
        remaining = rest[:i] + rest[i + 1:]
        for sub_matching in _matchings_recursive(remaining):
            yield [(first, partner)] + sub_matching


def _find_min_weight_matching(D: np.ndarray) -> List[Tuple[int, int]]:
    """Minimum-weight perfect matching via brute-force (105 matchings for n=8)."""
    n = D.shape[0]
    items = list(range(n))

    best_cost = float("inf")
    best_matching: List[Tuple[int, int]] = []

    for matching in _matchings_recursive(items):
        cost = sum(D[i, j] for i, j in matching)
        if cost < best_cost:
            best_cost = cost
            best_matching = matching

    return best_matching



def _render_thumb(img: np.ndarray, size: int) -> np.ndarray:
    """Resize image to fit in size x size cell, centered on dark background."""
    h, w = img.shape[:2]
    sc = (size - 4) / max(h, w)
    nh, nw = max(1, int(h * sc)), max(1, int(w * sc))
    resized = cv2.resize(img, (nw, nh))
    cell = np.full((size, size, 3), 40, dtype=np.uint8)
    dy, dx = (size - nh) // 2, (size - nw) // 2
    cell[dy : dy + nh, dx : dx + nw] = resized
    return cell


def _make_thumbnails_image(
    images: List[np.ndarray],
    cell: int = 80,
    cols: int = 8,
) -> np.ndarray:
    """Row of cluster representative thumbnails with labels."""
    n = len(images)
    rows = (n + cols - 1) // cols
    grid = np.full((rows * (cell + 16), cols * cell, 3), 30, dtype=np.uint8)
    for i in range(n):
        r, c = divmod(i, cols)
        y0, x0 = r * (cell + 16), c * cell
        grid[y0 : y0 + cell, x0 : x0 + cell] = _render_thumb(images[i], cell)
        cv2.putText(
            grid, f"C{i}", (x0 + 2, y0 + cell + 12),
            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1,
        )
    return grid


def _make_histogram_comparison(
    ab_hists_raw: np.ndarray,
    ab_hists_final: np.ndarray,
    n: int,
    cell_w: int = 120,
    cell_h: int = 60,
) -> np.ndarray:
    """Side-by-side ab histogram heatmaps: raw vs after suppression+power."""
    pad = 4
    label_h = 18
    col_w = cell_w + pad
    canvas_w = n * col_w + pad
    canvas_h = label_h + cell_h + pad + cell_h + label_h + pad
    canvas = np.full((canvas_h, canvas_w, 3), 30, dtype=np.uint8)

    cv2.putText(canvas, "Raw ab histogram", (pad, 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, (180, 180, 180), 1)
    cv2.putText(canvas, "After IDF + power", (pad, label_h + cell_h + pad + 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, (180, 180, 180), 1)

    for i in range(n):
        x0 = i * col_w + pad

        raw_2d = ab_hists_raw[i].reshape(AB_BINS, AB_BINS)
        mx = raw_2d.max()
        if mx > 0:
            raw_norm = (raw_2d / mx * 255).astype(np.uint8)
        else:
            raw_norm = np.zeros((AB_BINS, AB_BINS), dtype=np.uint8)
        raw_color = cv2.applyColorMap(
            cv2.resize(raw_norm, (cell_w, cell_h), interpolation=cv2.INTER_NEAREST),
            cv2.COLORMAP_HOT,
        )
        canvas[label_h : label_h + cell_h, x0 : x0 + cell_w] = raw_color

        fin_2d = ab_hists_final[i].reshape(AB_BINS, AB_BINS)
        mx = fin_2d.max()
        if mx > 0:
            fin_norm = (fin_2d / mx * 255).astype(np.uint8)
        else:
            fin_norm = np.zeros((AB_BINS, AB_BINS), dtype=np.uint8)
        fin_color = cv2.applyColorMap(
            cv2.resize(fin_norm, (cell_w, cell_h), interpolation=cv2.INTER_NEAREST),
            cv2.COLORMAP_HOT,
        )
        y2 = label_h + cell_h + pad + label_h
        canvas[y2 : y2 + cell_h, x0 : x0 + cell_w] = fin_color

        cv2.putText(canvas, f"C{i}", (x0 + 2, label_h + cell_h - 4),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 255, 255), 1)
        cv2.putText(canvas, f"C{i}", (x0 + 2, y2 + cell_h - 4),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 255, 255), 1)

    return canvas


def _make_distance_heatmap(D: np.ndarray, n: int, cell: int = 50) -> np.ndarray:
    """Distance matrix heatmap with labels and distance values."""
    margin = 40
    img_size = n * cell
    d_max = D.max()
    if d_max > 0:
        norm = (D / d_max * 255).astype(np.uint8)
    else:
        norm = np.zeros_like(D, dtype=np.uint8)
    heatmap = cv2.resize(norm, (img_size, img_size), interpolation=cv2.INTER_NEAREST)
    heatmap_color = cv2.applyColorMap(heatmap, cv2.COLORMAP_VIRIDIS)

    canvas = np.full((img_size + margin, img_size + margin, 3), 30, dtype=np.uint8)
    canvas[margin:, margin:] = heatmap_color

    for i in range(n):
        x = margin + i * cell + cell // 2 - 6
        cv2.putText(canvas, f"C{i}", (x, margin - 6),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (200, 200, 200), 1)
        y = margin + i * cell + cell // 2 + 4
        cv2.putText(canvas, f"C{i}", (4, y),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (200, 200, 200), 1)

    for i in range(n):
        for j in range(n):
            cx = margin + j * cell + cell // 2 - 10
            cy = margin + i * cell + cell // 2 + 4
            val = D[i, j]
            color = (0, 0, 0) if norm[i, j] > 128 else (255, 255, 255)
            cv2.putText(canvas, f"{val:.3f}", (cx, cy),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.25, color, 1)

    return canvas


def _make_pairs_image(
    images: List[np.ndarray],
    pairs: List[Tuple[int, int]],
    D: np.ndarray,
    cell: int = 80,
) -> np.ndarray:
    """Final pairs visualization: each pair side by side with distance."""
    n_pairs = len(pairs)
    pair_w = 2 * cell + 20
    canvas_h = cell + 30
    canvas_w = n_pairs * pair_w + 10
    canvas = np.full((canvas_h, canvas_w, 3), 30, dtype=np.uint8)

    for pi, (a, b) in enumerate(pairs):
        x0 = pi * pair_w + 5
        canvas[0 : cell, x0 : x0 + cell] = _render_thumb(images[a], cell)
        canvas[0 : cell, x0 + cell + 4 : x0 + 2 * cell + 4] = _render_thumb(images[b], cell)

        cv2.putText(canvas, f"C{a}", (x0 + 2, cell - 4),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 200, 0), 1)
        cv2.putText(canvas, f"C{b}", (x0 + cell + 6, cell - 4),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 200, 0), 1)

        d = D[a, b]
        cv2.putText(canvas, f"d={d:.4f}", (x0 + 4, cell + 18),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (180, 180, 180), 1)

        mid_x = x0 + cell + 2
        cv2.line(canvas, (mid_x, 10), (mid_x, cell - 10), (0, 200, 0), 2)

    return canvas


def _make_ranked_matches(
    images: List[np.ndarray],
    D: np.ndarray,
    cell: int = 60,
) -> np.ndarray:
    """For each cluster, show all others ranked by distance (closest first)."""
    n = len(images)
    label_w = 40
    row_h = cell + 4
    grid = np.full((n * row_h, label_w + (n - 1) * (cell + 2) + 10, 3), 30, dtype=np.uint8)

    for i in range(n):
        y0 = i * row_h
        cv2.putText(grid, f"C{i}", (4, y0 + cell // 2 + 4),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (200, 200, 200), 1)

        dists = D[i].copy()
        dists[i] = np.inf
        ranked = np.argsort(dists)

        for mi, j in enumerate(ranked):
            if dists[j] == np.inf:
                break
            x = label_w + mi * (cell + 2)
            grid[y0 : y0 + cell, x : x + cell] = _render_thumb(images[j], cell)
            cv2.putText(grid, f"C{j}", (x + 2, y0 + 10),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.25, (200, 200, 200), 1)
            cv2.putText(grid, f"{dists[j]:.3f}", (x + 2, y0 + cell - 3),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.25, (180, 180, 180), 1)

    return grid



def decode_base64_image(data_uri: str) -> np.ndarray:
    """Decode a PNG (or OpenCV-decodable) image from a data URI or raw base64.

    Args:
        data_uri: ``data:image/...;base64,...`` or plain base64 payload.

    Returns:
        Decoded image as BGR ``numpy.ndarray``.

    Raises:
        ValueError: If OpenCV cannot decode the image bytes.
    """
    if "," in data_uri:
        data_uri = data_uri.split(",", 1)[1]
    img_bytes = base64.b64decode(data_uri)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise ValueError("Failed to decode image from base64 data")
    return img_bgr



def _histogram_distance_pipeline(
    images: List[np.ndarray],
    masks: List[np.ndarray],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Raw + processed histograms and combined cosine distance matrix."""
    ab_raw, l_raw = _extract_histograms(images, masks)
    ab_final = _power_normalize(_idf_reweight(ab_raw))
    l_final = _power_normalize(_idf_reweight(l_raw))
    D_ab = _cosine_distance_matrix(ab_final)
    D_l = _cosine_distance_matrix(l_final)
    D = W_AB * D_ab + W_L * D_l
    return D, ab_raw, l_raw, ab_final, l_final


def cluster_histogram_matching_state(
    images: List[np.ndarray],
    masks: Optional[List[np.ndarray]] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute pairwise distances and final per-cluster LAB histogram features.

    Args:
        images: BGR crops, one per cluster representative.
        masks: Foreground masks aligned to ``images``; if omitted, masks are
            derived via ``generate_mask``.

    Returns:
        Tuple ``(D, ab_final, l_final)`` where ``D`` is the combined cosine
        distance matrix ``(n, n)``, and ``ab_final`` / ``l_final`` are row-wise
        processed histograms ``(n, n_bins)``.
    """
    if masks is None:
        masks = [generate_mask(img) for img in images]
    D, _ar, _lr, ab_final, l_final = _histogram_distance_pipeline(images, masks)
    return D, ab_final, l_final


def find_optimal_cluster_pairs(D: np.ndarray) -> List[Tuple[int, int]]:
    """Return a minimum-weight perfect matching over fully connected clusters.

    Args:
        D: Symmetric nonnegative distance matrix ``(n, n)`` with zeros on the
            diagonal; ``n`` must be even for a perfect matching.

    Returns:
        List of ``(i, j)`` index pairs partitioning ``range(n)`` into disjoint pairs
        minimizing ``sum(D[i, j])``.
    """
    return _find_min_weight_matching(D)


def match_cluster_representatives(
    images: List[np.ndarray],
    masks: Optional[List[np.ndarray]] = None,
    debug: bool = False,
    debug_dir: str = "debug",
) -> List[Tuple[int, int]]:
    """Match cluster representative images into pairs by color similarity.

    Extracts LAB histograms, suppresses common background colors,
    power-normalizes to focus on color presence, then finds the
    minimum-weight perfect matching on cosine distances.

    Args:
        images: BGR triangle images, one per cluster (length must be even).
        masks: Binary masks aligned to each image.  Generated from images
               if not provided.
        debug: If True, save intermediate images to debug_dir.
        debug_dir: Parent directory for debug output.

    Returns:
        List of ``(i, j)`` index pairs into ``images``. If ``len(images)`` is
        below two or odd, returns the trivial pairing ``[(i, i), ...]`` without
        running the matcher.

    """
    n = len(images)
    if n < 2 or n % 2 != 0:
        return [(i, i) for i in range(n)]

    dbg = DebugLogger(debug, debug_dir, subdir="matching")

    if masks is None:
        masks = [generate_mask(img) for img in images]

    D, ab_raw, l_raw, ab_final, l_final = _histogram_distance_pipeline(images, masks)

    dbg.log(f"\n{'=' * 60}")
    dbg.log(f"EDGE MATCHING PIPELINE")
    dbg.log(f"{'=' * 60}")
    dbg.log(f"  Clusters: {n}")
    dbg.log(f"  AB bins: {AB_BINS}x{AB_BINS} = {AB_BINS**2}")
    dbg.log(f"  L bins: {L_BINS}")
    dbg.log(f"  Weights: ab={W_AB}, L={W_L}")
    dbg.log(f"  Power exponent: {POWER}")

    dbg.log(f"\n  Distance matrix (combined):")
    for i in range(n):
        row = "    " + "  ".join(f"{D[i, j]:.4f}" for j in range(n))
        dbg.log(row)

    pairs = find_optimal_cluster_pairs(D)

    total_cost = sum(D[a, b] for a, b in pairs)
    dbg.log(f"\n  Optimal pairs (total cost {total_cost:.4f}):")
    for a, b in pairs:
        dbg.log(f"    C{a} <-> C{b}  (d={D[a, b]:.4f})")

    # Debug images
    if dbg.enabled:
        dbg.save_image(_make_thumbnails_image(images), "m01_representatives.png")
        dbg.save_image(
            _make_histogram_comparison(ab_raw, ab_final, n),
            "m02_histograms.png",
        )
        dbg.save_image(_make_distance_heatmap(D, n), "m03_distance_matrix.png")
        dbg.save_image(_make_ranked_matches(images, D), "m04_ranked_matches.png")
        dbg.save_image(_make_pairs_image(images, pairs, D), "m05_final_pairs.png")

        dbg.log(f"\n=== MATCHING DEBUG IMAGES ===")
        dbg.log(f"  - m01_representatives.png:  Cluster representative thumbnails")
        dbg.log(f"  - m02_histograms.png:       Raw vs processed ab histograms")
        dbg.log(f"  - m03_distance_matrix.png:  Pairwise distance heatmap with values")
        dbg.log(f"  - m04_ranked_matches.png:   Each cluster's nearest matches")
        dbg.log(f"  - m05_final_pairs.png:      Final optimal pairs")

    return pairs
