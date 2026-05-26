"""Command-line entry points for detection, batch detection, processing, and solving.

Each ``*_command`` function is wired from ``main()`` via ``argparse`` and returns
a process exit code (0 on success, nonzero on failure).
"""

import argparse
import json
import time
import sys
from pathlib import Path
import cv2
import numpy as np

# Add project root to path if running as script
if __name__ == "__main__":
    import os

    project_root = Path(__file__).parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

from src.core.detection import detect_pieces
from src.core.image_processing import process_bounding_boxes_to_triangles
from src.core.clustering import cluster_triangles
from src.core.utils import image_to_base64
from src.core.solve import solve_puzzle


def detect_command(args):
    """Run piece detection on a single image and print or save JSON results.

    Args:
        args: Parsed ``detect`` subcommand namespace (``image``, ``output``,
            ``visualize``, ``max_dim``, ``debug``, ``debug_dir``, etc.).

    Returns:
        ``0`` on success, ``1`` if the image cannot be read or another fatal error occurs.
    """
    print(f"Loading image: {args.image}")
    img_bgr = cv2.imread(str(args.image))

    if img_bgr is None:
        print(f"Error: Could not load image from {args.image}")
        return 1

    print(f"Detecting puzzle pieces...")
    start = time.time()
    boxes_data = detect_pieces(
        img_bgr,
        max_dim=args.max_dim,
        debug=args.debug,
        debug_dir=args.debug_dir,
    )
    elapsed = time.time() - start

    if len(boxes_data) != 9:
        print(f"Warning: Expected 9 pieces, found {len(boxes_data)}")

    # Convert to API format
    bounding_boxes = []
    for i, box in enumerate(boxes_data, start=1):
        bbox = {
            "id": f"box-{i}",
            "topLeft": {"x": box[0], "y": box[1]},
            "topRight": {"x": box[2], "y": box[3]},
            "bottomRight": {"x": box[4], "y": box[5]},
            "bottomLeft": {"x": box[6], "y": box[7]},
        }
        bounding_boxes.append(bbox)

    # Visualize bounding boxes with lime green
    vis_img = img_bgr.copy()
    lime_green = (0, 255, 0)  # BGR format: bright lime green

    for i, box in enumerate(boxes_data):
        # Convert to integer points
        pts = np.array(
            [
                [int(box[0]), int(box[1])],  # topLeft
                [int(box[2]), int(box[3])],  # topRight
                [int(box[4]), int(box[5])],  # bottomRight
                [int(box[6]), int(box[7])],  # bottomLeft
            ],
            dtype=np.int32,
        )

        # Draw filled polygon with transparency
        overlay = vis_img.copy()
        cv2.fillPoly(overlay, [pts], lime_green)
        cv2.addWeighted(overlay, 0.3, vis_img, 0.7, 0, vis_img)

        # Draw outline
        cv2.polylines(vis_img, [pts], isClosed=True, color=lime_green, thickness=2)

        # Draw piece number
        center_x = int((box[0] + box[2] + box[4] + box[6]) / 4)
        center_y = int((box[1] + box[3] + box[5] + box[7]) / 4)
        cv2.putText(
            vis_img,
            str(i + 1),
            (center_x - 10, center_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (255, 255, 255),
            2,
        )

    # Save visualization
    if args.visualize:
        vis_path = Path(args.visualize)
        cv2.imwrite(str(vis_path), vis_img)
        print(f"Saved visualization to: {vis_path}")
    elif args.output:
        # Auto-generate visualization filename
        output_path = Path(args.output)
        vis_path = output_path.parent / f"{output_path.stem}_visualization.png"
        cv2.imwrite(str(vis_path), vis_img)
        print(f"Saved visualization to: {vis_path}")

    # Output results
    if args.output:
        output_path = Path(args.output)
        with open(output_path, "w") as f:
            json.dump({"boundingBoxes": bounding_boxes}, f, indent=2)
        print(f"Saved bounding boxes to: {output_path}")
    else:
        print(json.dumps({"boundingBoxes": bounding_boxes}, indent=2))

    print(f"Detection completed in {elapsed:.3f}s")
    return 0


def batch_detect_command(args):
    """Run detection over every image in a directory and write per-image JSON.

    Args:
        args: Parsed ``batch-detect`` namespace (``input_dir``, ``output_dir``,
            ``visualize``, ``verbose``, ``max_dim``, ``debug``, ``debug_dir``).

    Returns:
        ``0`` if every image succeeded, ``1`` if any image failed or inputs are invalid.
    """
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)

    if not input_dir.exists():
        print(f"Error: Input directory not found: {input_dir}")
        return 1

    if not input_dir.is_dir():
        print(f"Error: Input path is not a directory: {input_dir}")
        return 1

    # Create output directory if it doesn't exist
    output_dir.mkdir(parents=True, exist_ok=True)

    # Supported image extensions
    image_extensions = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"}

    # Find all image files
    image_files = []
    for ext in image_extensions:
        image_files.extend(input_dir.glob(f"*{ext}"))
        image_files.extend(input_dir.glob(f"*{ext.upper()}"))

    if not image_files:
        print(f"Error: No image files found in {input_dir}")
        return 1

    print(f"Found {len(image_files)} image(s) to process")
    print(f"Input directory: {input_dir}")
    print(f"Output directory: {output_dir}")
    print()

    # Process each image
    successful = 0
    failed = 0
    total_start = time.time()

    for img_path in sorted(image_files):
        print(f"Processing: {img_path.name}")

        try:
            # Load image
            img_bgr = cv2.imread(str(img_path))
            if img_bgr is None:
                print(f"  Error: Could not load image")
                failed += 1
                continue

            # Detect pieces
            start = time.time()
            # For batch, put debug images in subdirectory per image when debug is on
            img_debug_dir = (
                str(Path(args.debug_dir) / img_path.stem)
                if args.debug
                else args.debug_dir
            )
            boxes_data = detect_pieces(
                img_bgr,
                max_dim=args.max_dim,
                debug=args.debug,
                debug_dir=img_debug_dir,
            )
            elapsed = time.time() - start

            if len(boxes_data) != 9:
                print(f"  Warning: Expected 9 pieces, found {len(boxes_data)}")

            # Convert to API format
            bounding_boxes = []
            for i, box in enumerate(boxes_data, start=1):
                bbox = {
                    "id": f"box-{i}",
                    "topLeft": {"x": box[0], "y": box[1]},
                    "topRight": {"x": box[2], "y": box[3]},
                    "bottomRight": {"x": box[4], "y": box[5]},
                    "bottomLeft": {"x": box[6], "y": box[7]},
                }
                bounding_boxes.append(bbox)

            # Save JSON output
            json_filename = output_dir / f"{img_path.stem}.json"
            with open(json_filename, "w") as f:
                json.dump({"boundingBoxes": bounding_boxes}, f, indent=2)

            # Save visualization if requested
            if args.visualize:
                vis_img = img_bgr.copy()
                lime_green = (0, 255, 0)  # BGR format: bright lime green

                for i, box in enumerate(boxes_data):
                    # Convert to integer points
                    pts = np.array(
                        [
                            [int(box[0]), int(box[1])],  # topLeft
                            [int(box[2]), int(box[3])],  # topRight
                            [int(box[4]), int(box[5])],  # bottomRight
                            [int(box[6]), int(box[7])],  # bottomLeft
                        ],
                        dtype=np.int32,
                    )

                    # Draw filled polygon with transparency
                    overlay = vis_img.copy()
                    cv2.fillPoly(overlay, [pts], lime_green)
                    cv2.addWeighted(overlay, 0.3, vis_img, 0.7, 0, vis_img)

                    # Draw outline
                    cv2.polylines(
                        vis_img, [pts], isClosed=True, color=lime_green, thickness=2
                    )

                    # Draw piece number
                    center_x = int((box[0] + box[2] + box[4] + box[6]) / 4)
                    center_y = int((box[1] + box[3] + box[5] + box[7]) / 4)
                    cv2.putText(
                        vis_img,
                        str(i + 1),
                        (center_x - 10, center_y),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        1,
                        (255, 255, 255),
                        2,
                    )

                vis_filename = output_dir / f"{img_path.stem}_visualization.png"
                cv2.imwrite(str(vis_filename), vis_img)
                print(
                    f"  Saved: {json_filename.name}, {vis_filename.name} ({elapsed:.3f}s)"
                )
            else:
                print(f"  Saved: {json_filename.name} ({elapsed:.3f}s)")

            successful += 1

        except Exception as e:
            print(f"  Error processing {img_path.name}: {e}")
            import traceback

            if args.verbose:
                traceback.print_exc()
            failed += 1
            continue

    total_elapsed = time.time() - total_start

    print()
    print(f"Batch processing completed:")
    print(f"  Successful: {successful}")
    print(f"  Failed: {failed}")
    print(f"  Total time: {total_elapsed:.3f}s")
    print(f"  Average time per image: {total_elapsed/len(image_files):.3f}s")

    return 0 if failed == 0 else 1


def process_command(args):
    """Warp boxes from JSON, split into triangles, cluster edges, and optionally save artifacts.

    Args:
        args: Parsed ``process`` namespace (``image``, ``bboxes``, ``warp_size``,
            ``k``, ``output_dir``, ``debug``, ``debug_dir``).

    Returns:
        ``0`` after a successful run, ``1`` on invalid inputs or geometry errors.
    """
    print(f"Loading image: {args.image}")
    img_bgr = cv2.imread(str(args.image))

    if img_bgr is None:
        print(f"Error: Could not load image from {args.image}")
        return 1

    # Load bounding boxes
    print(f"Loading bounding boxes: {args.bboxes}")
    with open(args.bboxes, "r") as f:
        data = json.load(f)

    bounding_boxes_api = data.get("boundingBoxes", [])
    if len(bounding_boxes_api) != 9:
        print(f"Error: Expected 9 bounding boxes, got {len(bounding_boxes_api)}")
        return 1

    # Convert to core format
    bounding_boxes_core = []
    for box in bounding_boxes_api:
        bounding_boxes_core.append(
            (
                box["topLeft"]["x"],
                box["topLeft"]["y"],
                box["topRight"]["x"],
                box["topRight"]["y"],
                box["bottomRight"]["x"],
                box["bottomRight"]["y"],
                box["bottomLeft"]["x"],
                box["bottomLeft"]["y"],
            )
        )

    # Process to pieces and triangles
    print("Processing bounding boxes to pieces and triangles...")
    start = time.time()
    pieces, triangles, tri_masks = process_bounding_boxes_to_triangles(
        img_bgr, bounding_boxes_core, warp_size=args.warp_size
    )
    elapsed_warp = time.time() - start
    print(f"  Warping and splitting completed in {elapsed_warp:.3f}s")

    if len(triangles) != 36:
        print(f"Error: Expected 36 triangles, got {len(triangles)}")
        return 1

    # Cluster triangles
    print(f"Clustering triangles (k={args.k})...")
    start = time.time()
    clusters = cluster_triangles(
        triangles, tri_masks, k=args.k,
        debug=getattr(args, "debug", False),
        debug_dir=getattr(args, "debug_dir", "debug"),
    )
    elapsed_cluster = time.time() - start
    print(f"  Clustering completed in {elapsed_cluster:.3f}s")

    # Save triangles if output directory specified
    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Create cluster directories
        unique_clusters = sorted(set(clusters))
        cluster_dirs = {}
        for cluster_id in unique_clusters:
            cluster_dir = output_dir / f"cluster_{cluster_id:02d}"
            cluster_dir.mkdir(parents=True, exist_ok=True)
            cluster_dirs[cluster_id] = cluster_dir

        print(f"Saving triangles to: {output_dir}")
        print(f"  Grouped into {len(unique_clusters)} cluster directories")

        # Save triangles grouped by cluster
        for i, (tri, cluster_id) in enumerate(zip(triangles, clusters)):
            piece_idx = i // 4
            tri_idx = i % 4
            tri_name = ["top", "bottom", "left", "right"][tri_idx]

            # Save in cluster directory
            cluster_dir = cluster_dirs[cluster_id]
            filename = cluster_dir / f"piece_{piece_idx+1:02d}_{tri_name}.png"
            cv2.imwrite(str(filename), tri)

        # Also save all triangles in root directory (for convenience)
        all_triangles_dir = output_dir / "all_triangles"
        all_triangles_dir.mkdir(parents=True, exist_ok=True)
        for i, (tri, cluster_id) in enumerate(zip(triangles, clusters)):
            piece_idx = i // 4
            tri_idx = i % 4
            tri_name = ["top", "bottom", "left", "right"][tri_idx]
            filename = (
                all_triangles_dir
                / f"piece_{piece_idx+1:02d}_{tri_name}_cluster_{cluster_id:02d}.png"
            )
            cv2.imwrite(str(filename), tri)

        # Save cluster assignments
        cluster_file = output_dir / "clusters.json"
        with open(cluster_file, "w") as f:
            json.dump(
                {
                    "clusters": clusters,
                    "total_triangles": len(triangles),
                    "num_clusters": len(set(clusters)),
                    "cluster_directories": {
                        str(cid): str(cluster_dirs[cid].name) for cid in unique_clusters
                    },
                },
                f,
                indent=2,
            )
        print(f"Saved cluster assignments to: {cluster_file}")

        # Print cluster directory structure
        print(f"\nDirectory structure:")
        print(f"  {output_dir.name}/")
        print(f"    all_triangles/  (all triangles with cluster suffix)")
        for cluster_id in unique_clusters:
            cluster_dir = cluster_dirs[cluster_id]
            count = sum(1 for _ in cluster_dir.glob("*.png"))
            print(f"    {cluster_dir.name}/  ({count} triangles)")

    # Print summary
    print(f"\nSummary:")
    print(f"  Total triangles: {len(triangles)}")
    print(f"  Number of clusters: {len(set(clusters))}")
    print(f"  Processing time: {elapsed_warp + elapsed_cluster:.3f}s")

    # Print cluster distribution
    from collections import Counter

    cluster_counts = Counter(clusters)
    print(f"\nCluster distribution:")
    for cluster_id, count in sorted(cluster_counts.items()):
        print(f"  Cluster {cluster_id}: {count} triangles")

    return 0


def solve_command(args):
    """Load a puzzle JSON payload, invoke the solver, and print or save the best layout.

    Args:
        args: Parsed ``solve`` namespace (``input`` file path or ``"-"`` for stdin,
            ``output`` path optional).

    Returns:
        ``0`` when a solution is produced, ``1`` on I/O, validation, or solver errors.
    """
    # Load JSON from file or stdin
    if args.input == "-":
        print("Reading JSON from stdin...")
        try:
            request_data = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON input: {e}")
            return 1
    else:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"Error: Input file not found: {input_path}")
            return 1
        print(f"Loading JSON from: {input_path}")

        # Detect encoding (handle UTF-16 BOM)
        with open(input_path, "rb") as f:
            first_bytes = f.read(4)
            if first_bytes.startswith(b"\xff\xfe"):
                encoding = "utf-16"
            elif first_bytes.startswith(b"\xfe\xff"):
                encoding = "utf-16"
            elif first_bytes.startswith(b"\xef\xbb\xbf"):
                encoding = "utf-8-sig"
            else:
                encoding = "utf-8"

        # Read file with detected encoding
        with open(input_path, "r", encoding=encoding) as f:
            try:
                request_data = json.load(f)
            except json.JSONDecodeError as e:
                print(f"Error: Invalid JSON in file: {e}")
                return 1

    # Validate request structure
    if "pieces" not in request_data:
        print("Error: Missing 'pieces' field in JSON")
        return 1
    if "matches" not in request_data:
        print("Error: Missing 'matches' field in JSON")
        return 1

    pieces_dict = request_data["pieces"]
    matches_dict = request_data["matches"]

    # Validate pieces
    if not isinstance(pieces_dict, dict):
        print("Error: 'pieces' must be an object/dictionary")
        return 1
    if len(pieces_dict) != 9:
        print(f"Error: Expected 9 pieces, got {len(pieces_dict)}")
        return 1

    # Validate matches
    if not isinstance(matches_dict, dict):
        print("Error: 'matches' must be an object/dictionary")
        return 1

    # Check all pieces have 4 edges
    for piece_idx_str, edges in pieces_dict.items():
        if not isinstance(edges, list) or len(edges) != 4:
            print(f"Error: Piece {piece_idx_str} must have exactly 4 edge cluster IDs")
            return 1
        if not all(isinstance(e, int) for e in edges):
            print(f"Error: Piece {piece_idx_str} edges must be integers")
            return 1

    # Convert string keys to integers for solve function
    try:
        pieces_int = {int(k): v for k, v in pieces_dict.items()}
        matches_int = {int(k): int(v) for k, v in matches_dict.items()}
    except (ValueError, TypeError) as e:
        print(f"Error: Invalid key/value types: {e}")
        return 1

    # Validate piece indices are 0-8
    if set(pieces_int.keys()) != set(range(9)):
        print(f"Error: Pieces must have indices 0-8, got: {sorted(pieces_int.keys())}")
        return 1

    # Solve the puzzle
    print("Solving puzzle...")
    start = time.time()
    try:
        positions_int, rotations_int = solve_puzzle(pieces_int, matches_int)
    except ValueError as e:
        print(f"Error: {e}")
        return 1
    except Exception as e:
        print(f"Error: Unexpected error during solving: {e}")
        import traceback

        traceback.print_exc()
        return 1

    elapsed = time.time() - start
    print(f"Solution found in {elapsed:.3f}s")

    # Convert back to string keys for JSON output
    positions_str = {str(k): v for k, v in positions_int.items()}
    rotations_str = {str(k): v for k, v in rotations_int.items()}

    response = {"positions": positions_str, "rotations": rotations_str}

    # Output results
    if args.output:
        output_path = Path(args.output)
        with open(output_path, "w") as f:
            json.dump(response, f, indent=2)
        print(f"Saved solution to: {output_path}")
    else:
        print(json.dumps(response, indent=2))

    # Print summary
    print(f"\nSolution summary:")
    print(f"  Positions: {len(positions_str)} pieces placed")
    print(f"  Rotations: {len(rotations_str)} pieces rotated")

    # Print grid visualization
    print(f"\nGrid layout:")
    grid = [["" for _ in range(3)] for _ in range(3)]
    for piece_idx_str, pos_idx in positions_str.items():
        row = pos_idx // 3
        col = pos_idx % 3
        grid[row][col] = piece_idx_str

    for row in grid:
        print(f"  {' '.join(f'{cell:>3}' for cell in row)}")

    return 0


def main():
    """Parse CLI arguments, dispatch to a subcommand, and return a process exit code.

    Returns:
        ``0`` on success. ``1`` if no subcommand was given (after printing help) or
        if the selected subcommand returns a nonzero status.
    """
    parser = argparse.ArgumentParser(description="Puzzle piece processing CLI")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Detect command
    detect_parser = subparsers.add_parser(
        "detect", help="Detect puzzle pieces in an image"
    )
    detect_parser.add_argument("image", type=str, help="Input image path")
    detect_parser.add_argument(
        "-o", "--output", type=str, help="Output JSON file for bounding boxes"
    )
    detect_parser.add_argument(
        "-v",
        "--visualize",
        type=str,
        help="Output path for visualization image (auto-generated if -o is used)",
    )
    detect_parser.add_argument(
        "--max-dim",
        type=int,
        default=800,
        help="Max image dimension for processing (default: 800)",
    )
    detect_parser.add_argument(
        "--warp-size",
        type=int,
        default=900,
        help="Warped square size for grid detection (default: 900)",
    )
    detect_parser.add_argument("--debug", action="store_true", help="Save debug images")
    detect_parser.add_argument(
        "--debug-dir",
        type=str,
        default="debug",
        help="Directory for debug images (default: debug)",
    )
    detect_parser.set_defaults(func=detect_command)

    # Batch detect command
    batch_detect_parser = subparsers.add_parser(
        "batch-detect", help="Detect puzzle pieces in all images in a directory"
    )
    batch_detect_parser.add_argument(
        "input_dir", type=str, help="Input directory containing images"
    )
    batch_detect_parser.add_argument(
        "output_dir",
        type=str,
        help="Output directory for JSON files and visualizations",
    )
    batch_detect_parser.add_argument(
        "--visualize", action="store_true", help="Generate visualization images"
    )
    batch_detect_parser.add_argument(
        "--verbose", action="store_true", help="Show detailed error messages"
    )
    batch_detect_parser.add_argument(
        "--max-dim",
        type=int,
        default=800,
        help="Max image dimension for processing (default: 800)",
    )
    batch_detect_parser.add_argument(
        "--warp-size",
        type=int,
        default=900,
        help="Warped square size for grid detection (default: 900)",
    )
    batch_detect_parser.add_argument(
        "--debug", action="store_true", help="Save debug images"
    )
    batch_detect_parser.add_argument(
        "--debug-dir",
        type=str,
        default="debug",
        help="Directory for debug images (default: debug)",
    )
    batch_detect_parser.set_defaults(func=batch_detect_command)

    # Process command
    process_parser = subparsers.add_parser(
        "process", help="Process bounding boxes to triangles and cluster"
    )
    process_parser.add_argument("image", type=str, help="Input image path")
    process_parser.add_argument(
        "bboxes", type=str, help="JSON file with bounding boxes"
    )
    process_parser.add_argument(
        "-o", "--output-dir", type=str, help="Output directory for triangles"
    )
    process_parser.add_argument(
        "-k", type=int, default=8, help="Number of clusters (default: 8)"
    )
    process_parser.add_argument(
        "--warp-size", type=int, default=256, help="Warped square size (default: 256)"
    )
    process_parser.add_argument(
        "--debug", action="store_true", help="Save clustering debug images"
    )
    process_parser.add_argument(
        "--debug-dir",
        type=str,
        default="debug",
        help="Directory for debug images (default: debug)",
    )
    process_parser.set_defaults(func=process_command)

    # Solve command
    solve_parser = subparsers.add_parser(
        "solve", help="Solve puzzle given pieces and matches"
    )
    solve_parser.add_argument(
        "input", type=str, help="JSON file with pieces and matches (use '-' for stdin)"
    )
    solve_parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="Output JSON file for solution (default: stdout)",
    )
    solve_parser.set_defaults(func=solve_command)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    return args.func(args)


if __name__ == "__main__":
    exit(main())
