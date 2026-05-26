"""FastAPI application server."""

import json
import logging
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from src.api.config import get_settings
from src.api.routes import (
    detect_pieces_endpoint,
    submit_bounding_boxes_endpoint,
    solve_puzzle_endpoint,
    get_puzzle_hint_endpoint,
    get_puzzle_info_endpoint,
    match_triangles_endpoint,
)
from src.api.exceptions import APIError
from src.core.errors import NoSolutionError, PuzzleSolvedError, ValidationError

app = FastAPI()
settings = get_settings()


class JsonFormatter(logging.Formatter):
    """Small JSON formatter for API logs with optional request ids."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = getattr(record, "request_id", None)
        if request_id:
            payload["requestId"] = request_id
        if record.exc_info:
            payload["excInfo"] = self.formatException(record.exc_info)
        return json.dumps(payload)


handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
logging.basicConfig(level=settings.log_level.upper(), handlers=[handler])
logger = logging.getLogger(__name__)


@app.exception_handler(APIError)
async def api_error_handler(request: Request, exc: APIError):
    """Serialize ``APIError`` subclasses as JSON with the correct status code.

    Args:
        request: Incoming HTTP request (unused; required by FastAPI signature).
        exc: Raised ``APIError`` with ``message`` and ``status_code``.

    Returns:
        ``JSONResponse`` with body ``{"detail": <message>}``.
    """
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


@app.exception_handler(ValidationError)
@app.exception_handler(NoSolutionError)
@app.exception_handler(PuzzleSolvedError)
async def core_error_handler(request: Request, exc: Exception):
    """Map domain errors raised by core modules to client-safe 400 responses."""
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    """Catch unhandled exceptions and return a generic 500 JSON payload.

    Args:
        request: Incoming HTTP request.
        exc: Any uncaught exception.

    Returns:
        ``JSONResponse`` with status 500 and a generic error message.
    """
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.exception("Unhandled request error", extra={"request_id": request_id})
    detail = (
        f"Internal server error: {exc}"
        if settings.debug_errors or settings.environment != "production"
        else "Internal server error"
    )
    return JSONResponse(
        status_code=500,
        content={"detail": detail, "requestId": request_id},
        headers={"X-Request-ID": request_id},
    )


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    """Attach a request id to every response for log correlation."""
    request_id = request.headers.get("X-Request-ID", str(uuid4()))
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes
app.post("/api/detect")(detect_pieces_endpoint)
app.post("/api/submit")(submit_bounding_boxes_endpoint)
app.post("/api/solve")(solve_puzzle_endpoint)
app.post("/api/hint")(get_puzzle_hint_endpoint)
app.post("/api/info")(get_puzzle_info_endpoint)
app.post("/api/match-triangles")(match_triangles_endpoint)
app.get("/health")(lambda: {"status": "ok"})
app.get("/ready")(lambda: {"status": "ready"})


@app.get("/")
async def root():
    """Return service metadata and a list of mounted API paths.

    Returns:
        JSON object with ``message`` and ``endpoints`` keys.
    """
    return {
        "message": "Puzzle Piece API Server",
        "endpoints": [
            "/api/detect",
            "/api/submit",
            "/api/solve",
            "/api/hint",
            "/api/info",
            "/api/match-triangles",
        ],
    }


if __name__ == "__main__":
    import os

    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
