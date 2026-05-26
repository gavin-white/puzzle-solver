"""Utility functions."""

import base64
import cv2
import numpy as np


def image_to_base64(img: np.ndarray) -> str:
    """Encode a BGR image as a PNG data URI for API responses.

    Args:
        img: OpenCV image in BGR layout (uint8 or encodable by cv2.imencode).

    Returns:
        A ``data:image/png;base64,...`` URI string suitable for JSON or HTML.

    """
    _, buffer = cv2.imencode(".png", img)
    img_base64 = base64.b64encode(buffer).decode("utf-8")
    return f"data:image/png;base64,{img_base64}"
