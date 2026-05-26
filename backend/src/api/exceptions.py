"""Custom exceptions for the API."""


class APIError(Exception):
    """Base exception for API errors."""

    status_code: int = 500

    def __init__(self, message: str, status_code: int = None):
        """Create an API error with optional HTTP status override.

        Args:
            message: Human-readable error detail returned to the client.
            status_code: If provided, overrides the class default status code.

        Returns:
            None
        """
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        super().__init__(self.message)


class BadRequestError(APIError):
    """400 Bad Request - Invalid input from client."""

    status_code = 400


class NotFoundError(APIError):
    """404 Not Found."""

    status_code = 404


class ValidationError(BadRequestError):
    """Validation error for request data."""

    pass


class NoSolutionError(BadRequestError):
    """No solution found for the puzzle."""

    def __init__(
        self, message: str = "No solution found for the given puzzle configuration"
    ):
        """Signal that the solver found no valid arrangement.

        Args:
            message: Client-facing detail string.

        Returns:
            None
        """
        super().__init__(message)


class PuzzleSolvedError(BadRequestError):
    """Puzzle is already solved, no hint needed."""

    def __init__(self, message: str = "No hint found: puzzle is already solved"):
        """Signal that no hint applies because the puzzle is already solved.

        Args:
            message: Client-facing detail string.

        Returns:
            None
        """
        super().__init__(message)


class InternalError(APIError):
    """500 Internal Server Error."""

    status_code = 500
