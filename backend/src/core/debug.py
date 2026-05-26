"""Debug logging and image saving for the CV pipeline."""

from __future__ import annotations

import os
import time
import logging
from contextlib import contextmanager
from datetime import datetime
from typing import Dict

import cv2
import numpy as np

logger = logging.getLogger(__name__)


class DebugLogger:
    """Conditionally logs messages and saves intermediate images."""

    def __init__(
        self,
        enabled: bool = False,
        debug_dir: str = "",
        subdir: str = "",
    ):
        """Prepare optional on-disk debug folder for intermediate images.

        Args:
            enabled: When False, ``log`` is a no-op and images are not written.
            debug_dir: Base directory for runs; ignored when ``enabled`` is False.
            subdir: If non-empty, images go under ``debug_dir/subdir``; otherwise a
                timestamped subdirectory is created under ``debug_dir``.

        Returns:
            None
        """
        self.enabled = enabled
        if enabled and debug_dir:
            if subdir:
                # debug_dir is the run base (e.g. debug/20260316_123456)
                self.debug_dir = os.path.join(debug_dir, subdir)
            else:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                self.debug_dir = os.path.join(debug_dir, timestamp)
            os.makedirs(self.debug_dir, exist_ok=True)
        else:
            self.debug_dir = debug_dir

    def log(self, message: str) -> None:
        """Log a message when debug logging is enabled.

        Args:
            message: Text to print to stdout.

        Returns:
            None
        """
        if self.enabled:
            logger.info(message)

    def save_image(self, img: np.ndarray, filename: str) -> None:
        """Write ``img`` to ``debug_dir/filename`` when debug is enabled.

        Args:
            img: Image array (BGR for typical OpenCV usage).
            filename: File name only; joined with the configured debug directory.

        Returns:
            None
        """
        if self.enabled and self.debug_dir:
            filepath = os.path.join(self.debug_dir, filename)
            cv2.imwrite(filepath, img)
            logger.info("  Saved: %s", filepath)


class PipelineTimer:
    """Collects wall-clock timings for named pipeline steps."""

    def __init__(self) -> None:
        """Initialize an empty timing map.

        Returns:
            None
        """
        self.timings: Dict[str, float] = {}

    @contextmanager
    def step(self, name: str):
        """Context manager that records elapsed seconds for ``name``.

        Args:
            name: Step label stored in ``timings``.

        Yields:
            Control to the wrapped block; duration is recorded on exit.
        """
        t0 = time.perf_counter()
        yield
        self.timings[name] = time.perf_counter() - t0

    def summary(self, dbg: DebugLogger) -> None:
        """Log per-step milliseconds and share of total time.

        Args:
            dbg: Logger used for formatted output (respects ``enabled``).

        Returns:
            None
        """
        total = sum(self.timings.values())
        dbg.log(f"\n=== PIPELINE TIMING ===")
        for name, elapsed in self.timings.items():
            pct = elapsed / total * 100 if total > 0 else 0
            dbg.log(f"  {name:<40s} {elapsed*1000:7.1f} ms  ({pct:4.1f}%)")
        dbg.log(f"  {'TOTAL':<40s} {total*1000:7.1f} ms")
