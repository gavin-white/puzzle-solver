"""Runtime settings for the API server."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-backed settings used by API routes and server setup."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    cors_origins: list[str] = ["http://localhost:5173"]
    debug_detection: bool = False
    debug_clustering: bool = False
    debug_errors: bool = False
    log_level: str = "INFO"
    max_upload_bytes: int = 15 * 1024 * 1024
    environment: Literal["development", "test", "production"] = "development"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: str | list[str] | None) -> list[str]:
        """Accept either a list or a comma-separated `CORS_ORIGINS` string."""
        if value is None or value == "":
            return ["http://localhost:5173"]
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    """Return cached settings so env parsing happens once per process."""
    return Settings()
