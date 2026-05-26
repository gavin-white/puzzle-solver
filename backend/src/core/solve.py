"""Puzzle solving algorithms."""

from typing import Dict, Tuple, List, Set, FrozenSet
import math

from src.core.errors import NoSolutionError, PuzzleSolvedError, ValidationError


class SolveStats:
    """Mutable container for tracking solver metrics across recursion."""

    def __init__(self):
        """Initialize counters (placement attempts start at zero).

        Returns:
            None
        """
        self.attempts = 0


class PieceRotation:
    """Represents a puzzle piece at a specific rotation."""

    def __init__(self, piece_id: str, edges: List[int], rotation: int):
        """
        Initialize a piece rotation.

        Args:
            piece_id: Original piece identifier (e.g., "0", "1", etc.).
            edges: List of 4 edge cluster IDs [top, right, bottom, left].
            rotation: Rotation index (0-3), where each increment is 90 degrees clockwise.
        """
        self.piece_id = piece_id
        self.edges = edges[rotation:] + edges[:rotation]
        self.rotation = rotation

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, PieceRotation):
            return NotImplemented
        return self.piece_id == other.piece_id and self.rotation == other.rotation

    def __hash__(self) -> int:
        return hash((self.piece_id, self.rotation))

    def __str__(self):
        return f"{self.piece_id} {self.rotation} {self.edges}"

    def __repr__(self):
        return f"{self.piece_id} {self.rotation} {self.edges}"

    @staticmethod
    def get_all_rotations(piece_id: str, edges: List[int]) -> List["PieceRotation"]:
        """
        Generate all 4 rotations of a piece.

        Args:
            piece_id: Piece identifier.
            edges: List of 4 edge cluster IDs [top, right, bottom, left].

        Returns:
            List of 4 PieceRotation objects, one for each rotation (0-3).
        """
        return [PieceRotation(piece_id, edges, i) for i in range(len(edges))]


class PuzzleConstraint:
    """Represents a single adjacency constraint between two grid positions."""

    def __init__(self, edge: int, other_placement: int, other_placement_edge: int):
        """
        Initialize a puzzle constraint.

        Args:
            edge: Edge index on the current piece (0=top, 1=right, 2=bottom, 3=left).
            other_placement: Grid position of the adjacent piece.
            other_placement_edge: Edge index on the adjacent piece that must match.
        """
        self.edge = edge
        self.other_placement = other_placement
        self.other_placement_edge = other_placement_edge


class PuzzleConstraints:
    """Container for all puzzle constraints."""

    def __init__(self, constraints: Dict[int, Dict[int, Tuple[int, int]]]):
        """
        Initialize puzzle constraints.

        Args:
            constraints: Dict mapping grid position -> {adjacent_position: (this_edge, that_edge)}.
        """
        self._constraints = {}
        self.puzzle_size = len(constraints)
        for placement, constraint in constraints.items():
            self._constraints[placement] = [
                PuzzleConstraint(edge, other_placement, other_placement_edge)
                for other_placement, (edge, other_placement_edge) in constraint.items()
            ]

    def get_constraints(self, position: int) -> List[PuzzleConstraint]:
        """
        Get all constraints for a given grid position.

        Args:
            position: Grid position (0 to puzzle_size-1).

        Returns:
            List of PuzzleConstraint objects for the position.
        """
        return self._constraints[position]

    @staticmethod
    def square(size: int) -> "PuzzleConstraints":
        """
        Create constraints for a square grid puzzle.

        Args:
            size: Grid dimension (e.g., 3 for a 3x3 puzzle).

        Returns:
            PuzzleConstraints for a size x size grid.
        """
        return PuzzleConstraints(
            PuzzleConstraints._generate_rectangular_constraints(size, size)
        )

    @staticmethod
    def _generate_rectangular_constraints(
        height: int, width: int
    ) -> Dict[int, Dict[int, Tuple[int, int]]]:
        """
        Generate adjacency constraints for a rectangular grid puzzle.

        Args:
            height: Number of rows in the grid.
            width: Number of columns in the grid.

        Returns:
            Dict mapping grid position -> {adjacent_position: (this_edge, that_edge)}.
            Edges: 0=top, 1=right, 2=bottom, 3=left.
        """
        constraints = {}
        for row in range(height):
            for col in range(width):
                con = {}
                # Top neighbor
                if row > 0:
                    con[(row - 1) * width + col] = (
                        0,
                        2,
                    )  # My top edge matches their bottom edge
                # Left neighbor
                if col > 0:
                    con[row * width + col - 1] = (
                        3,
                        1,
                    )  # My left edge matches their right edge
                # Bottom neighbor
                if row < height - 1:
                    con[(row + 1) * width + col] = (
                        2,
                        0,
                    )  # My bottom edge matches their top edge
                # Right neighbor
                if col < width - 1:
                    con[row * width + col + 1] = (
                        1,
                        3,
                    )  # My right edge matches their left edge
                constraints[row * width + col] = con
        return constraints


def place_piece(
    constraints: PuzzleConstraints,
    matches: Dict[int, int],
    piece_sets: Dict[str, Set[PieceRotation]],
    edge_value_dict: Dict[Tuple[int, int], Set[PieceRotation]],
    placement_candidates: Dict[int, Set[PieceRotation]],
    grid: Dict[int, PieceRotation],
    piece: PieceRotation,
    placement: int,
) -> Tuple[Dict[int, PieceRotation], Dict[int, Set[PieceRotation]]]:
    """
    Place a piece on the grid and update candidate sets via constraint propagation.

    Args:
        constraints: Puzzle adjacency constraints.
        matches: Dict mapping edge cluster ID -> matching cluster ID.
        piece_sets: Dict mapping piece_id -> set of all rotations of that piece.
        edge_value_dict: Dict mapping (edge_index, cluster_id) -> set of matching pieces.
        placement_candidates: Dict mapping grid position -> set of candidate pieces.
        grid: Current grid state as {position: PieceRotation}.
        piece: The piece to place.
        placement: Grid position to place the piece.

    Returns:
        Tuple of (new_grid, new_placement_candidates) with updated state.
    """
    new_grid = grid.copy()
    new_grid[placement] = piece
    new_placement_candidates = {
        k: v for k, v in placement_candidates.items() if k != placement
    }

    # For each candidate set: remove all rotations of the piece being placed
    for i, candidates in new_placement_candidates.items():
        new_placement_candidates[i] = candidates - piece_sets[piece.piece_id]

    # For each adjacency constraint: update adjacent placements candidates
    # keeping only ones that would be a valid neighbor to the placed piece
    adjacent_constraints = constraints.get_constraints(placement)
    for constraint in adjacent_constraints:
        edge_value_placed = piece.edges[constraint.edge]
        matching_edge_value = matches[edge_value_placed]
        if constraint.other_placement in new_placement_candidates:
            key = (constraint.other_placement_edge, matching_edge_value)
            if key in edge_value_dict:
                new_placement_candidates[constraint.other_placement] = (
                    new_placement_candidates[constraint.other_placement]
                    & edge_value_dict[key]
                )
            else:
                new_placement_candidates[constraint.other_placement] = set()

    return new_grid, new_placement_candidates


def get_solutions_rec(
    constraints: PuzzleConstraints,
    matches: Dict[int, int],
    piece_sets: Dict[str, Set[PieceRotation]],
    edge_value_dict: Dict[Tuple[int, int], Set[PieceRotation]],
    pieces: List[PieceRotation],
    grid: Dict[int, PieceRotation],
    placement_candidates: Dict[int, Set[PieceRotation]],
    stats: SolveStats = None,
) -> List[Dict[int, PieceRotation]]:
    """
    Recursively find all solutions using most-constrained-first heuristic.

    Args:
        constraints: Puzzle adjacency constraints.
        matches: Dict mapping edge cluster ID -> matching cluster ID.
        piece_sets: Dict mapping piece_id -> set of all rotations of that piece.
        edge_value_dict: Dict mapping (edge_index, cluster_id) -> set of matching pieces.
        pieces: List of all piece rotations (unused, kept for signature compatibility).
        grid: Current partial solution as {position: PieceRotation}.
        placement_candidates: Dict mapping unfilled positions -> candidate pieces.
        stats: SolveStats instance.

    Returns:
        List of complete solutions, each as {grid_position: PieceRotation}.
    """
    # Find the most constrained placement (fewest candidates)
    most_constrained_placement = None
    min_candidates = math.inf
    for placement, candidates in placement_candidates.items():
        if len(candidates) < min_candidates:
            min_candidates = len(candidates)
            most_constrained_placement = placement

    # If no more placements needed, we found a solution
    if most_constrained_placement is None:
        return [grid]

    # If any placement has no candidates, this path is invalid
    if min_candidates == 0:
        return []

    # Try each candidate for the most constrained placement
    all_solutions = []
    for candidate in placement_candidates[most_constrained_placement]:
        new_grid, new_placement_candidates = place_piece(
            constraints,
            matches,
            piece_sets,
            edge_value_dict,
            placement_candidates,
            grid,
            candidate,
            most_constrained_placement,
        )
        sub_solutions = get_solutions_rec(
            constraints,
            matches,
            piece_sets,
            edge_value_dict,
            pieces,
            new_grid,
            new_placement_candidates,
            stats,
        )
        if stats is not None and len(sub_solutions) == 0:
            stats.attempts += 1
        all_solutions += sub_solutions

    return all_solutions


def get_all_solutions(
    constraints: PuzzleConstraints,
    matches: Dict[int, int],
    pieces: List[PieceRotation],
    stats: SolveStats = None,
) -> List[Dict[int, PieceRotation]]:
    """
    Find all valid puzzle solutions using constraint propagation.

    Args:
        constraints: PuzzleConstraints defining grid adjacency rules.
        matches: Dict mapping edge cluster ID -> matching cluster ID.
        pieces: List of all PieceRotation objects (all rotations of all pieces).
        stats: Optional SolveStats to accumulate placement attempt counts.

    Returns:
        List of solutions, each as {grid_position: PieceRotation}.
    """
    # Build mapping of (edge_idx, edge_value) -> {piece, ...}
    edge_value_dict = {}
    for piece in pieces:
        for i, edge in enumerate(piece.edges):
            key = (i, edge)
            if key not in edge_value_dict:
                edge_value_dict[key] = {piece}
            else:
                edge_value_dict[key].add(piece)

    puzzle_size = constraints.puzzle_size
    initial_candidates = {
        grid_location: set(pieces) for grid_location in range(puzzle_size)
    }
    piece_sets = {
        pid: set([p for p in pieces if p.piece_id == pid])
        for pid in set([p.piece_id for p in pieces])
    }

    return get_solutions_rec(
        constraints,
        matches,
        piece_sets,
        edge_value_dict,
        [],
        {},
        initial_candidates,
        stats,
    )


def find_best_solution(
    solutions: List[Dict[int, PieceRotation]],
    current_placements: Dict[int, PieceRotation],
) -> Dict[int, PieceRotation]:
    """
    Find the solution closest to the current state.

    Uses a priority cascade:
    1. Most pieces correctly placed AND rotated
    2. Most pieces correctly placed (tie-breaker)
    3. Fewest rotations needed (final tie-breaker)

    Args:
        solutions: List of solutions, each as {grid_position: PieceRotation}.
        current_placements: Current state as {grid_position: PieceRotation}.

    Returns:
        The best matching solution as {grid_position: PieceRotation}.
    """

    def num_correctly_placed_and_rotated(placements, solution):
        return sum([1 if solution[pos] == pr else 0 for pos, pr in placements.items()])

    def num_correctly_placed(placements, solution):
        return sum(
            [1 if solution[pos].piece_id == pr.piece_id else 0 for pos, pr in placements.items()]
        )

    def num_rotations_needed(placements, solution):
        return sum(
            [
                abs(solution[pos].rotation - pr.rotation)
                for pos, pr in placements.items()
            ]
        )

    max_correctly_placed_and_rotated = max(
        [num_correctly_placed_and_rotated(current_placements, s) for s in solutions]
    )
    best_solutions = [
        s
        for s in solutions
        if num_correctly_placed_and_rotated(current_placements, s)
        == max_correctly_placed_and_rotated
    ]
    if len(best_solutions) == 1:
        return best_solutions[0]

    max_correctly_placed = max(
        [num_correctly_placed(current_placements, s) for s in best_solutions]
    )
    best_solutions = [
        s
        for s in best_solutions
        if num_correctly_placed(current_placements, s) == max_correctly_placed
    ]
    if len(best_solutions) == 1:
        return best_solutions[0]

    return min(
        best_solutions, key=lambda s: num_rotations_needed(current_placements, s)
    )


def solution_to_output_format(
    solution: Dict[int, PieceRotation],
) -> Tuple[Dict[str, int], Dict[str, int]]:
    """
    Convert a solution from internal format to API output format.

    Args:
        solution: Solution as {grid_position: PieceRotation}.

    Returns:
        Tuple of (positions, rotations):
        - positions: {piece_id: grid_position}
        - rotations: {piece_id: rotation (0-3)}
    """
    positions = {}
    rotations = {}

    for grid_pos, piece_rotation in solution.items():
        piece_id = piece_rotation.piece_id
        positions[piece_id] = grid_pos
        rotations[piece_id] = piece_rotation.rotation

    return positions, rotations


def get_current_placements(
    current_placements: Tuple[Dict[str, int], Dict[str, int]],
    pieces: Dict[str, List[int]],
) -> Dict[int, PieceRotation]:
    """
    Convert current placements from API format to internal format.

    Args:
        current_placements: Tuple of (positions, rotations) dicts, or None.
            - positions: {piece_id: grid_position}
            - rotations: {piece_id: rotation}
        pieces: Dict mapping piece_id -> list of edge cluster IDs.

    Returns:
        Current state as {grid_position: PieceRotation}.
    """
    if current_placements is None:
        # Default: piece at position matching its index, rotation 0
        placements = {}
        for i, (piece_id, edges) in enumerate(pieces.items()):
            placements[i] = PieceRotation(piece_id, edges, 0)
        return placements

    positions, rotations = current_placements
    placements = {}
    for piece_id, pos in positions.items():
        rotation = rotations.get(piece_id, 0)
        placements[pos] = PieceRotation(piece_id, pieces[piece_id], rotation)
    return placements


def define_solution_adjacency(
    solution: Dict[int, PieceRotation], constraints: PuzzleConstraints
) -> FrozenSet[Tuple[str, str, int, int]]:
    """
    Generate a unique key identifying a solution's structural adjacency.

    Two solutions with the same adjacency key are structurally equivalent
    (same piece arrangement), even if rotations differ.

    Args:
        solution: Solution as {grid_position: PieceRotation}.
        constraints: Puzzle constraints defining adjacencies.

    Returns:
        Frozen set of (piece1_id, piece2_id, edge1, edge2) tuples.
    """
    adjacency = set()
    for pos, placement in solution.items():
        cons = constraints.get_constraints(pos)
        for con in cons:
            piece1 = solution[pos]
            piece2 = solution[con.other_placement]
            adjacency.add(
                (
                    piece1.piece_id,
                    piece2.piece_id,
                    (con.edge + piece1.rotation) % 4,
                    (con.other_placement_edge + piece2.rotation) % 4,
                )
            )
    return frozenset(adjacency)


def _solve_puzzle_internal(
    pieces: Dict[str, List[int]],
    matches: Dict[int, int],
    current_placements: Tuple[Dict[str, int], Dict[str, int]] = None,
) -> Tuple[
    List[Dict[int, PieceRotation]],
    Dict[int, PieceRotation],
    PuzzleConstraints,
    SolveStats,
]:
    """
    Internal solver returning solutions in internal format.

    Args:
        pieces: Dict mapping piece_id -> list of 4 edge cluster IDs.
        matches: Dict mapping cluster ID -> matching cluster ID.
        current_placements: Optional tuple of (positions, rotations) dicts.

    Returns:
        Tuple of (all_solutions, best_solution, constraints, stats):
        - all_solutions: List of solutions as {grid_position: PieceRotation}
        - best_solution: Best solution as {grid_position: PieceRotation}
        - constraints: The PuzzleConstraints used
        - stats: SolveStats with placement attempt metrics

    Raises:
        ValidationError: If number of pieces is not a perfect square.
        NoSolutionError: If no valid solution exists.
    """
    num_pieces = len(pieces)
    grid_size = int(math.sqrt(num_pieces))
    if grid_size * grid_size != num_pieces:
        raise ValidationError(
            f"Number of pieces ({num_pieces}) must be a perfect square"
        )

    # Generate all rotations for all pieces
    all_piece_rotations = []
    for piece_id, edges in pieces.items():
        all_piece_rotations.extend(PieceRotation.get_all_rotations(piece_id, edges))

    # Generate constraints for rectangular grid
    puzzle_constraints = PuzzleConstraints.square(grid_size)

    # Find all solutions, tracking placement attempts
    stats = SolveStats()
    raw_solutions = get_all_solutions(
        puzzle_constraints, matches, all_piece_rotations, stats
    )

    if not raw_solutions:
        raise NoSolutionError()

    placements = get_current_placements(current_placements, pieces)
    best_solution = find_best_solution(raw_solutions, placements)

    return raw_solutions, best_solution, puzzle_constraints, stats


def get_puzzle_info(
    pieces: Dict[str, List[int]],
    matches: Dict[int, int],
    current_placements: Tuple[Dict[str, int], Dict[str, int]] = None,
) -> Tuple[
    List[Tuple[Dict[str, int], Dict[str, int]]],
    Tuple[Dict[str, int], Dict[str, int]],
    int,
    int,
    int,
    int,
]:
    """
    Get puzzle solutions and analysis information.

    Args:
        pieces: Dict mapping piece_id -> list of 4 edge cluster IDs.
        matches: Dict mapping cluster ID -> matching cluster ID.
        current_placements: Optional tuple of (positions, rotations) dicts.

    Returns:
        Tuple of (all_solutions, best_solution, difficulty, num_valid_quads, num_solutions, num_unique_solutions):
        - all_solutions: List of (positions, rotations) tuples
        - best_solution: (positions, rotations) tuple
        - difficulty: Difficulty score based on number of placement attempts
        - num_valid_quads: Number of unique valid 2x2 arrangements
        - num_solutions: Total number of solutions
        - num_unique_solutions: Number of structurally unique solutions

    Raises:
        ValidationError: If number of pieces is not a perfect square.
        NoSolutionError: If no valid solution exists.
    """
    raw_solutions, best_solution, puzzle_constraints, stats = _solve_puzzle_internal(
        pieces, matches, current_placements
    )

    # Convert to output format
    all_solutions = [solution_to_output_format(s) for s in raw_solutions]
    best_solution_output = solution_to_output_format(best_solution)

    # Calculate valid quads
    all_piece_rotations = []
    for piece_id, edges in pieces.items():
        all_piece_rotations.extend(PieceRotation.get_all_rotations(piece_id, edges))

    quad_constraints = PuzzleConstraints.square(2)
    valid_quads = get_all_solutions(quad_constraints, matches, all_piece_rotations)
    num_valid_quads = len(
        set([define_solution_adjacency(s, quad_constraints) for s in valid_quads])
    )
    num_unique_solutions = len(
        set([define_solution_adjacency(s, puzzle_constraints) for s in raw_solutions])
    )

    return (
        all_solutions,
        best_solution_output,
        stats.attempts,
        num_valid_quads,
        len(all_solutions),
        num_unique_solutions,
    )


def get_puzzle_hint(
    pieces: Dict[str, List[int]],
    matches: Dict[int, int],
    current_placements: Tuple[Dict[str, int], Dict[str, int]] = None,
) -> Tuple[int, PieceRotation]:
    """
    Get a hint for the next correct piece placement.

    Finds the first position where the current piece doesn't match the
    best solution and returns the correct piece for that position.

    Args:
        pieces: Dict mapping piece_id -> list of 4 edge cluster IDs.
        matches: Dict mapping cluster ID -> matching cluster ID.
        current_placements: Optional tuple of (positions, rotations) dicts.

    Returns:
        Tuple of (grid_position, PieceRotation) for the hint.

    Raises:
        ValidationError: If number of pieces is not a perfect square.
        NoSolutionError: If no valid solution exists.
        PuzzleSolvedError: If puzzle is already correctly solved.
    """
    _, best_solution, _, _ = _solve_puzzle_internal(pieces, matches, current_placements)

    # Get current placements in internal format
    placements = get_current_placements(current_placements, pieces)

    # Find first position where current piece doesn't match solution
    position_to_hint = next(
        (
            position
            for position, piece in placements.items()
            if best_solution[position] != piece
        ),
        None,
    )

    # If all placed pieces are correct, find an empty position
    if position_to_hint is None and current_placements is not None:
        positions, _ = current_placements
        placed_positions = set(positions.values())
        position_to_hint = next(
            (
                position
                for position in best_solution
                if position not in placed_positions
            ),
            None,
        )

    if position_to_hint is None:
        raise PuzzleSolvedError()

    return position_to_hint, best_solution[position_to_hint]


def solve_puzzle(
    pieces: Dict[str, List[int]],
    matches: Dict[int, int],
    current_placements: Tuple[Dict[str, int], Dict[str, int]] = None,
) -> Tuple[
    List[Tuple[Dict[str, int], Dict[str, int]]], Tuple[Dict[str, int], Dict[str, int]]
]:
    """
    Solve the puzzle by finding all valid arrangements and the best solution.

    Args:
        pieces: Dict mapping piece_id -> list of 4 edge cluster IDs [top, right, bottom, left].
        matches: Dict mapping cluster ID -> matching cluster ID (bidirectional).
        current_placements: Optional tuple of (positions, rotations) for current state.
            - positions: {piece_id: grid_position}
            - rotations: {piece_id: rotation}

    Returns:
        Tuple of (all_solutions, best_solution):
        - all_solutions: List of (positions, rotations) tuples
        - best_solution: (positions, rotations) tuple for the best match to current state

    Raises:
        ValidationError: If number of pieces is not a perfect square.
        NoSolutionError: If no valid solution exists.
    """
    raw_solutions, best_solution, _, _ = _solve_puzzle_internal(
        pieces, matches, current_placements
    )

    # Convert to output format
    all_solutions = [solution_to_output_format(s) for s in raw_solutions]
    best_solution_output = solution_to_output_format(best_solution)

    return all_solutions, best_solution_output
