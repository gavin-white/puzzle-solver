"""Edge clustering pipeline for grouping similar puzzle-piece edges.

Groups triangle edge-images (9 pieces x 4 edges = 36 triangles) into k
clusters based on visual similarity using pretrained MobileNetV2 embeddings.

Pipeline stages:

1.  Extract embeddings — feed masked triangles through MobileNetV2
2.  Compute cosine distance matrix
3.  Cluster — agglomerative clustering with complete linkage
4.  Refine — iterative k-medoids until convergence

The model is lazy-loaded on first call and cached for the process lifetime.
"""

from __future__ import annotations

from typing import List

import cv2
import numpy as np

from .debug import DebugLogger, PipelineTimer


MAX_MEDOID_ITERS = 20
EMBED_DIM = 1280  # MobileNetV2 feature dimension

_SIDE_NAMES = ["top", "bottom", "left", "right"]


_model = None
_transform = None


def _get_model_and_transform():
    """Load MobileNetV2 (no classifier) on first call, cache thereafter."""
    global _model, _transform

    if _model is not None:
        return _model, _transform

    import torch
    from torchvision import models, transforms

    weights = models.MobileNet_V2_Weights.IMAGENET1K_V1
    base = models.mobilenet_v2(weights=weights)

    base.classifier = torch.nn.Identity()
    base.eval()
    for p in base.parameters():
        p.requires_grad_(False)

    _model = base

    _transform = transforms.Compose([
        transforms.ToPILImage(),
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.485, 0.456, 0.406],
            std=[0.229, 0.224, 0.225],
        ),
    ])

    return _model, _transform



def _extract_embeddings(
    triangles: List[np.ndarray],
    masks: List[np.ndarray],
) -> np.ndarray:
    """Run each masked triangle through MobileNetV2 and return (N, 1280)."""
    import torch

    model, transform = _get_model_and_transform()

    tensors = []
    for img, mask in zip(triangles, masks):
        masked = img.copy()
        masked[mask == 0] = 0
        rgb = cv2.cvtColor(masked, cv2.COLOR_BGR2RGB)
        tensors.append(transform(rgb))

    batch = torch.stack(tensors)

    with torch.no_grad():
        embeddings = model(batch)

    return embeddings.numpy()



def _cosine_distance_matrix(embeddings: np.ndarray) -> np.ndarray:
    """Pairwise cosine distance matrix from (N, D) embedding array."""
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    normed = embeddings / norms
    similarity = normed @ normed.T
    return 1.0 - np.clip(similarity, -1.0, 1.0).astype(np.float32)



def _agglomerative_complete(n: int, k: int, D: np.ndarray) -> List[int]:
    """Agglomerative clustering with complete linkage."""
    clusters: List[set[int]] = [{i} for i in range(n)]

    def _max_dist(a: set[int], b: set[int]) -> float:
        return float(max(D[i, j] for i in a for j in b))

    while len(clusters) > k:
        best = (1e9, -1, -1)
        m = len(clusters)
        for i in range(m):
            for j in range(i + 1, m):
                d = _max_dist(clusters[i], clusters[j])
                if d < best[0]:
                    best = (d, i, j)
        _, bi, bj = best
        clusters[bi] |= clusters[bj]
        clusters.pop(bj)

    labels = [-1] * n
    for cid, idxs in enumerate(clusters):
        for idx in idxs:
            labels[idx] = cid
    return labels



def _refine_by_medoids(
    labels: List[int],
    D: np.ndarray,
    max_iters: int = MAX_MEDOID_ITERS,
) -> List[int]:
    """Iterative k-medoids refinement until convergence."""
    labs = np.array(labels, dtype=np.int32)
    k = int(labs.max() + 1)
    n = D.shape[0]

    for _ in range(max_iters):
        medoids: List[int] = []
        for c in range(k):
            idxs = np.where(labs == c)[0]
            if len(idxs) == 0:
                medoids.append(0)
                continue
            costs = [float(D[i, idxs].sum()) for i in idxs]
            medoids.append(int(idxs[int(np.argmin(costs))]))

        new_labs = np.zeros(n, dtype=np.int32)
        for i in range(n):
            ds = [float(D[i, m]) for m in medoids]
            new_labs[i] = int(np.argmin(ds))

        if np.array_equal(labs, new_labs):
            break
        labs = new_labs

    return labs.tolist()



def _tri_label(idx: int) -> str:
    return f"P{idx // 4 + 1}-{_SIDE_NAMES[idx % 4][0].upper()}"


def _tri_label_compact(idx: int) -> str:
    """Short id: piece 1–9 + side letter (e.g. 3b)."""
    return f"{idx // 4 + 1}{_SIDE_NAMES[idx % 4][0].lower()}"


def _put_text_outline(
    img: np.ndarray,
    text: str,
    org: tuple[int, int],
    font_scale: float,
    fg: tuple[int, int, int],
    thickness: int = 1,
) -> None:
    """White/light text with dark outline for readability on varied backgrounds."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            cv2.putText(
                img, text, (org[0] + dx, org[1] + dy), font, font_scale, (0, 0, 0), thickness + 1, cv2.LINE_AA,
            )
    cv2.putText(img, text, org, font, font_scale, fg, thickness, cv2.LINE_AA)


def _put_text_centered_in_rect(
    img: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    text: str,
    font_scale: float,
    color: tuple[int, int, int],
    thickness: int = 1,
) -> None:
    font = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), _bl = cv2.getTextSize(text, font, font_scale, thickness)
    tx = x + max(0, (w - tw) // 2)
    # putText uses baseline y; this centers text in the rect (common OpenCV pattern).
    ty = y + (h + th) // 2
    cv2.putText(img, text, (tx, ty), font, font_scale, color, thickness, cv2.LINE_AA)


# Distinct BGR colors for puzzle pieces 1–9 (legend + scatter).
_PIECE_COLORS_BGR: List[tuple[int, int, int]] = [
    (41, 74, 200),
    (36, 179, 76),
    (209, 99, 36),
    (189, 69, 199),
    (36, 189, 189),
    (89, 89, 255),
    (60, 200, 130),
    (255, 180, 50),
    (200, 200, 60),
]

# Left accent for vertical embedding strips (cluster id mod len).
_CLUSTER_STRIP_BGR: List[tuple[int, int, int]] = [
    (142, 62, 40),
    (52, 152, 62),
    (194, 92, 52),
    (166, 72, 176),
    (62, 162, 172),
    (72, 72, 210),
    (92, 182, 120),
    (62, 142, 210),
]


def _make_embedding_visualization(
    triangles: List[np.ndarray],
    embeddings: np.ndarray,
    labels: List[int],
) -> np.ndarray:
    """One vertical strip per edge (dims run top→bottom), sorted by cluster; cluster-colored accent only."""
    _ = triangles
    n, _d = embeddings.shape
    if n == 0:
        return np.full((64, 64, 3), 255, dtype=np.uint8)

    order = sorted(range(n), key=lambda i: (int(labels[i]), i))
    e = embeddings.astype(np.float64)
    lo = e.min(axis=1, keepdims=True)
    hi = e.max(axis=1, keepdims=True)
    e = (e - lo) / (hi - lo + 1e-12)

    strip_h = 540
    strip_w = 16
    col_gap = 2
    cluster_gap = 8
    pad_x = 10
    pad_y = 6

    accent_w = 3
    col_w = accent_w + strip_w

    x_sim = pad_x
    for j, i in enumerate(order):
        if j > 0:
            x_sim += col_gap
            if int(labels[i]) != int(labels[order[j - 1]]):
                x_sim += cluster_gap
        x_sim += col_w
    total_w = x_sim + pad_x
    total_h = pad_y * 2 + strip_h
    canvas = np.full((total_h, total_w, 3), 255, dtype=np.uint8)

    x = pad_x
    y_strip = pad_y
    for j, i in enumerate(order):
        if j > 0:
            x += col_gap
            if int(labels[i]) != int(labels[order[j - 1]]):
                x += cluster_gap
        v = e[i : i + 1].reshape(-1, 1)
        u8 = (v * 255.0).astype(np.uint8)
        colored = cv2.applyColorMap(u8, cv2.COLORMAP_TURBO)
        strip = cv2.resize(colored, (strip_w, strip_h), interpolation=cv2.INTER_AREA)
        acc = _CLUSTER_STRIP_BGR[int(labels[i]) % len(_CLUSTER_STRIP_BGR)]
        cv2.rectangle(
            canvas,
            (x, y_strip),
            (x + accent_w - 1, y_strip + strip_h - 1),
            acc,
            -1,
        )
        canvas[y_strip : y_strip + strip_h, x + accent_w : x + col_w] = strip
        x += col_w

    return canvas


def _render_tri_thumb(tri: np.ndarray, size: int) -> np.ndarray:
    th, tw = tri.shape[:2]
    sc = (size - 2) / max(th, tw)
    nh, nw = max(1, int(th * sc)), max(1, int(tw * sc))
    resized = cv2.resize(tri, (nw, nh))
    cell_img = np.full((size, size, 3), 255, dtype=np.uint8)
    dy, dx = (size - nh) // 2, (size - nw) // 2
    cell_img[dy : dy + nh, dx : dx + nw] = resized
    return cell_img


def _make_cluster_grid(
    triangles: List[np.ndarray],
    labels: List[int],
    cell: int = 124,
) -> np.ndarray:
    """Triangles arranged by cluster (one row per cluster); large thumbs, minimal padding."""
    k = max(labels) + 1
    clusters: List[List[int]] = [[] for _ in range(k)]
    for i, lab in enumerate(labels):
        clusters[lab].append(i)
    max_per = max(len(c) for c in clusters) if clusters else 1
    font = cv2.FONT_HERSHEY_SIMPLEX
    strip_w = 0
    for ci in range(k):
        lbl = f"Cluster {ci}"
        (tw, _), _ = cv2.getTextSize(lbl, font, 0.48, 1)
        strip_w = max(strip_w, tw + 16)
    gap = 6
    bg = (255, 255, 255)
    w = strip_w + gap + max_per * cell
    h = k * cell
    grid = np.full((h, w, 3), bg, dtype=np.uint8)

    for ci, members in enumerate(clusters):
        y0 = ci * cell
        _put_text_centered_in_rect(grid, 0, y0, strip_w, cell, f"Cluster {ci}", 0.48, (40, 40, 40), 1)
        for mi, tri_idx in enumerate(members):
            x0 = strip_w + gap + mi * cell
            tri = triangles[tri_idx]
            th, tw = tri.shape[:2]
            sc = cell / max(th, tw)
            nh, nw = max(1, int(th * sc)), max(1, int(tw * sc))
            resized = cv2.resize(tri, (nw, nh))
            dy = y0 + (cell - nh) // 2
            dx = x0 + (cell - nw) // 2
            grid[dy : dy + nh, dx : dx + nw] = resized
    return grid


def _make_distance_heatmap(
    D: np.ndarray,
    labels: List[int],
    cell: int = 20,
) -> np.ndarray:
    """Distance matrix sorted by cluster; axis uses compact labels in dedicated margin cells."""
    n = D.shape[0]
    k = max(labels) + 1
    order: List[int] = []
    cluster_starts: List[int] = []
    for c in range(k):
        cluster_starts.append(len(order))
        order.extend(i for i in range(n) if labels[i] == c)
    D_sorted = np.zeros_like(D)
    for si, oi in enumerate(order):
        for sj, oj in enumerate(order):
            D_sorted[si, sj] = D[oi, oj]
    d_max = D_sorted.max()
    if d_max > 0:
        norm = (D_sorted / d_max * 255).astype(np.uint8)
    else:
        norm = np.zeros_like(D_sorted, dtype=np.uint8)
    img_size = n * cell
    heatmap_raw = cv2.resize(norm, (img_size, img_size), interpolation=cv2.INTER_NEAREST)
    heatmap_colored = cv2.applyColorMap(heatmap_raw, cv2.COLORMAP_VIRIDIS)

    margin = 26
    bg = (255, 255, 255)
    canvas = np.full((img_size + margin, img_size + margin, 3), bg, dtype=np.uint8)
    canvas[margin : margin + img_size, margin : margin + img_size] = heatmap_colored

    for cs in cluster_starts[1:]:
        px = margin + cs * cell
        cv2.line(canvas, (px, margin), (px, margin + img_size), (255, 255, 255), 2)
        cv2.line(canvas, (margin, px), (margin + img_size, px), (255, 255, 255), 2)

    font_scale = 0.38
    col = (45, 45, 45)
    for j in range(n):
        lbl = _tri_label_compact(order[j])
        x0 = margin + j * cell
        _put_text_centered_in_rect(canvas, x0, 2, cell, margin - 4, lbl, font_scale, col, 1)
    for i in range(n):
        lbl = _tri_label_compact(order[i])
        y0 = margin + i * cell
        _put_text_centered_in_rect(canvas, 0, y0, margin - 4, cell, lbl, font_scale, col, 1)

    return canvas


def _make_nearest_neighbors_grid(
    triangles: List[np.ndarray],
    D: np.ndarray,
    labels: List[int],
    top_n: int = 5,
    cell: int = 64,
) -> np.ndarray:
    """Each triangle's top-N nearest neighbors (green=same cluster, red=different)."""
    n = len(triangles)
    label_w = 50
    row_h = cell + 4
    grid = np.full((n * row_h, label_w + (top_n + 1) * cell + 10, 3), 255, dtype=np.uint8)
    for i in range(n):
        y0 = i * row_h
        cv2.putText(grid, _tri_label_compact(i), (4, y0 + cell // 2 + 4),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 60, 60), 1)
        x0 = label_w
        grid[y0 : y0 + cell, x0 : x0 + cell] = _render_tri_thumb(triangles[i], cell)
        cv2.rectangle(grid, (x0, y0), (x0 + cell - 1, y0 + cell - 1), (255, 255, 255), 1)
        dists = D[i].copy()
        dists[i] = np.inf
        ranked = np.argsort(dists)[:top_n]
        for mi, j in enumerate(ranked):
            x = label_w + (mi + 1) * cell + 8
            grid[y0 : y0 + cell, x : x + cell] = _render_tri_thumb(triangles[j], cell)
            same = labels[i] == labels[j]
            color = (0, 200, 0) if same else (0, 0, 180)
            cv2.rectangle(grid, (x, y0), (x + cell - 1, y0 + cell - 1), color, 2 if same else 1)
            cv2.putText(grid, f"{dists[j]:.3f}", (x + 2, y0 + cell - 3),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.25, (180, 180, 180), 1)
            cv2.putText(grid, _tri_label_compact(j), (x + 2, y0 + 10),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.25, (60, 60, 60), 1)
    return grid



def cluster_triangles(
    triangles: List[np.ndarray],
    masks: List[np.ndarray],
    k: int = 8,
    debug: bool = False,
    debug_dir: str = "debug",
) -> List[int]:
    """Cluster triangle edge-images by visual similarity.

    Uses MobileNetV2 (pretrained on ImageNet) as a feature extractor to
    produce 1280-dim embeddings, then clusters via cosine distance with
    agglomerative clustering and k-medoids refinement.

    Args:
        triangles: List of triangle BGR images (36 for a 3x3 puzzle).
        masks: List of binary masks (0/255) aligned to each triangle.
        k: Number of clusters.
        debug: If True, save intermediate images and log progress.
        debug_dir: Parent directory for debug output.

    Returns:
        List of cluster IDs (one per triangle).
    """
    dbg = DebugLogger(debug, debug_dir)
    timer = PipelineTimer()
    n = len(triangles)

    dbg.log(f"\n{'=' * 60}")
    dbg.log(f"EDGE CLUSTERING PIPELINE")
    dbg.log(f"{'=' * 60}")
    dbg.log(f"  Triangles: {n}")
    dbg.log(f"  Target clusters: {k}")
    dbg.log(f"  Model: MobileNetV2 (ImageNet, {EMBED_DIM}-dim)")

    # Stage 1: extract embeddings
    with timer.step("1. Extract embeddings"):
        embeddings = _extract_embeddings(triangles, masks)
        dbg.log(f"\nStep 1: MobileNetV2 embedding extraction")
        dbg.log(f"  Input: {n} triangle images, masked")
        dbg.log(f"  Preprocessed to 224x224, ImageNet normalization")
        dbg.log(f"  Output: ({n}, {EMBED_DIM}) embedding matrix")

        norms = np.linalg.norm(embeddings, axis=1)
        dbg.log(f"  Embedding norms: [{norms.min():.2f}, {norms.max():.2f}] "
                f"(mean {norms.mean():.2f})")

    # Stage 2: distance matrix
    with timer.step("2. Distance matrix"):
        D = _cosine_distance_matrix(embeddings)
        nonzero = D[D > 0]
        dbg.log(f"\nStep 2: Cosine distance matrix ({n}x{n})")
        if len(nonzero) > 0:
            dbg.log(f"  Range: [{nonzero.min():.4f}, {nonzero.max():.4f}]")
            dbg.log(f"  Mean:  {nonzero.mean():.4f}")

    # Stage 3: cluster
    with timer.step("3. Agglomerative clustering"):
        labels = _agglomerative_complete(n, k, D)
        cluster_sizes = [labels.count(c) for c in range(k)]
        dbg.log(f"\nStep 3: Agglomerative clustering (complete linkage, k={k})")
        dbg.log(f"  Initial cluster sizes: {cluster_sizes}")

    # Stage 4: refine
    with timer.step("4. Medoid refinement"):
        labels = _refine_by_medoids(labels, D)
        cluster_sizes = [labels.count(c) for c in range(k)]
        dbg.log(f"\nStep 4: K-medoids refinement (converged)")
        dbg.log(f"  Final cluster sizes: {cluster_sizes}")

        for c in range(k):
            members = [_tri_label(i) for i, l in enumerate(labels) if l == c]
            dbg.log(f"    Cluster {c}: {', '.join(members)}")

        if dbg.enabled:
            dbg.save_image(
                _make_embedding_visualization(triangles, embeddings, labels),
                "c01_embeddings.png",
            )
            dbg.save_image(
                _make_cluster_grid(triangles, labels), "c04_clusters.png",
            )
            dbg.save_image(
                _make_distance_heatmap(D, labels), "c03_distance_matrix.png",
            )
            dbg.save_image(
                _make_nearest_neighbors_grid(triangles, D, labels),
                "c05_nearest_neighbors.png",
            )

    timer.summary(dbg)

    if dbg.enabled:
        dbg.log(f"\n=== CLUSTERING DEBUG IMAGES ===")
        dbg.log(f"  - c01_embeddings.png:      Vertical strips by cluster, accent only (no text labels)")
        dbg.log(f"  - c03_distance_matrix.png: Cosine distance matrix sorted by cluster")
        dbg.log(f"  - c04_clusters.png:        Final cluster assignments")
        dbg.log(f"  - c05_nearest_neighbors.png: Top-5 matches per triangle")

    return labels
