"""Shared domain exceptions for puzzle solving and API boundaries."""


class CoreError(Exception):
    """Base class for domain-level errors."""


class ValidationError(CoreError):
    """Invalid puzzle state or request data."""


class NoSolutionError(CoreError):
    """No valid solution exists for the puzzle."""

    def __init__(
        self, message: str = "No solution found for the given puzzle configuration"
    ) -> None:
        super().__init__(message)


class PuzzleSolvedError(CoreError):
    """No hint is needed because the puzzle is already solved."""

    def __init__(self, message: str = "No hint found: puzzle is already solved") -> None:
        super().__init__(message)
