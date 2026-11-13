"""Re-encoding of uploaded photos (epic E11; docs/ARCHITECTURE.md section 10).

Only JPEG of at most MAX_EDGE_PX on either edge is accepted: every client scales and converts a
photo before sending it, so the server opens no other decoder and never decodes a large image.
The size is read from the header before any pixel is decoded. The result is WebP in two sizes,
with the orientation applied and every piece of metadata (location, camera, comments) dropped.

Before Pillow sees the bytes, `check_structure` walks the JPEG markers: a file with too many
segments, too much metadata or too many scans is refused, because each of them costs time or
memory before the first pixel (a progressive JPEG with thousands of repeated scans decodes for
minutes).

These functions are CPU work: call them through `UploadGate.reencode` (src/core/files.py), which
runs them in a worker thread behind a semaphore.
"""

import io
from dataclasses import dataclass

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from src.core.exceptions import DomainError

MAX_EDGE_PX = 2560
DISPLAY_EDGE_PX = 1920
THUMB_EDGE_PX = 320
DISPLAY_QUALITY = 80
THUMB_QUALITY = 70
# Pillow's own guard against decompression bombs, set just above what we accept: anything larger
# raises before decoding even if a check above were ever skipped.
Image.MAX_IMAGE_PIXELS = MAX_EDGE_PX * MAX_EDGE_PX
# The structure of a JPEG a camera or a canvas writes: a handful of segments before the first scan
# (EXIF, ICC, tables), one scan for a baseline JPEG and about ten for a progressive one.
MAX_HEADER_SEGMENTS = 64
MAX_METADATA_BYTES = 512 * 1024
MAX_SCANS = 32
MAX_FILL_BYTES = 16  # 0xFF padding before a marker; encoders write none or one
_SRGB = ImageCms.createProfile("sRGB")
_STANDALONE_MARKERS = frozenset({0x01, *range(0xD0, 0xD9)})  # TEM, RST0-7, SOI
_SOS, _EOI = 0xDA, 0xD9


@dataclass(frozen=True)
class EncodedPhoto:
    display: bytes
    thumb: bytes
    width: int  # of the display variant
    height: int


def unsupported_media_type() -> DomainError:
    return DomainError(
        status_code=415,
        error_code="UNSUPPORTED_MEDIA_TYPE",
        message="Only JPEG photos are accepted; convert the photo to JPEG first.",
    )


def _invalid_image() -> DomainError:
    return DomainError(
        status_code=422, error_code="INVALID_IMAGE", message="The photo cannot be read."
    )


def _too_large() -> DomainError:
    return DomainError(
        status_code=422,
        error_code="IMAGE_TOO_LARGE",
        message=f"The photo is larger than {MAX_EDGE_PX} px on an edge; scale it first.",
        extra={"max_edge_px": MAX_EDGE_PX},
    )


def check_structure(data: bytes) -> None:
    """Walk the markers up to the first scan, then count the scans; refuse what no camera writes.

    Inside the compressed data every 0xFF byte is followed by 0x00 (byte stuffing) or is a real
    marker, so counting FF DA after the first scan counts the scans."""
    position, size = 2, len(data)
    segments = metadata = 0
    while True:
        if position >= size or data[position] != 0xFF:
            raise _invalid_image()
        start = position
        while position < size and data[position] == 0xFF:
            position += 1  # fill bytes
            if position - start > MAX_FILL_BYTES:
                raise _invalid_image()
        if position >= size:
            raise _invalid_image()
        marker = data[position]
        position += 1
        if marker in _STANDALONE_MARKERS:
            continue
        if marker == _EOI or position + 2 > size:
            raise _invalid_image()
        length = int.from_bytes(data[position : position + 2], "big")
        segments += 1
        if length < 2 or segments > MAX_HEADER_SEGMENTS:
            raise _invalid_image()
        if 0xE0 <= marker <= 0xEF or marker == 0xFE:  # APPn and comments
            metadata += length
            if metadata > MAX_METADATA_BYTES:
                raise _invalid_image()
        position += length
        if marker == _SOS:
            break
    if 1 + data.count(b"\xff\xda", position) > MAX_SCANS:
        raise _invalid_image()


def _to_srgb(image: Image.Image, icc: bytes | None) -> Image.Image:
    """Colours of a wide-gamut photo converted to sRGB before its profile is dropped."""
    if not icc:
        return image
    try:
        profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        converted = ImageCms.profileToProfile(image, profile, _SRGB, outputMode="RGB")
    except (ImageCms.PyCMSError, OSError, ValueError, TypeError):
        return image  # a broken profile: keep the colours as they are
    return converted if converted is not None else image


def _fit(image: Image.Image, edge: int) -> Image.Image:
    """The image scaled down to fit `edge` (never up); the same object when it already fits."""
    if max(image.size) <= edge:
        return image
    scale = edge / max(image.size)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS, reducing_gap=2.0)


def _webp(image: Image.Image, quality: int) -> bytes:
    buffer = io.BytesIO()
    # No exif, no icc_profile, no xmp: nothing of the original travels on.
    image.save(buffer, format="WEBP", quality=quality, method=4)
    return buffer.getvalue()


def reencode_photo(data: bytes) -> EncodedPhoto:
    """A client's JPEG -> the stored WebP variants. Raises DomainError 415/422."""
    if not data.startswith(b"\xff\xd8\xff"):
        raise unsupported_media_type()
    check_structure(data)
    try:
        with Image.open(io.BytesIO(data), formats=["JPEG"]) as source:
            # Only the header is parsed so far.
            if max(source.size) > MAX_EDGE_PX:
                raise _too_large()
            source.load()
            ImageOps.exif_transpose(source, in_place=True)  # no second full-size copy
            image = _to_srgb(source, source.info.get("icc_profile"))
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            image.info.clear()  # nothing of the original's metadata may travel on
            # Each step keeps only the smaller image: one full-size image at a time.
            display_image = _fit(image, DISPLAY_EDGE_PX)
            del image
            display = _webp(display_image, DISPLAY_QUALITY)
            width, height = display_image.size
            thumb = _webp(_fit(display_image, THUMB_EDGE_PX), THUMB_QUALITY)
            del display_image
    except DomainError:
        raise
    except Image.DecompressionBombError as exc:  # Pillow's own size guard, before decoding
        raise _too_large() from exc
    except UnidentifiedImageError as exc:
        raise unsupported_media_type() from exc
    except (OSError, ValueError, SyntaxError) as exc:
        raise _invalid_image() from exc
    return EncodedPhoto(display=display, thumb=thumb, width=width, height=height)
