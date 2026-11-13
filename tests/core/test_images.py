"""Re-encoding of uploaded photos (src/core/images.py): only JPEG of at most 2560 px goes in,
WebP without any metadata comes out."""

import io
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest
from PIL import Image, ImageCms

from src.core.exceptions import DomainError
from src.core.images import (
    DISPLAY_EDGE_PX,
    MAX_EDGE_PX,
    THUMB_EDGE_PX,
    reencode_photo,
)

GPS_IFD = 0x8825
ORIENTATION = 0x0112


def jpeg(
    size: tuple[int, int] = (800, 600),
    *,
    orientation: int | None = None,
    gps: bool = False,
    progressive: bool = False,
    mode: str = "RGB",
) -> bytes:
    image = Image.new(mode, size, "red" if mode == "RGB" else 0)
    # A marker in the top-left corner shows where "up" ended.
    for x in range(10):
        for y in range(10):
            image.putpixel((x, y), (0, 0, 255) if mode == "RGB" else 255)
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"  # camera make
    exif[0x9286] = "secret comment"
    if orientation is not None:
        exif[ORIENTATION] = orientation
    if gps:
        exif.get_ifd(GPS_IFD).update({1: "N", 2: (59.0, 26.0, 0.0), 3: "E", 4: (24.0, 45.0, 0.0)})
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif.tobytes(), progressive=progressive, quality=85)
    return buffer.getvalue()


def _error(data: bytes) -> DomainError:
    with pytest.raises(DomainError) as caught:
        reencode_photo(data)
    return caught.value


def test_a_photo_becomes_webp_in_two_sizes_without_any_metadata() -> None:
    result = reencode_photo(jpeg((2400, 1800), gps=True))

    for data, edge in ((result.display, DISPLAY_EDGE_PX), (result.thumb, THUMB_EDGE_PX)):
        image = Image.open(io.BytesIO(data))
        assert image.format == "WEBP"
        assert max(image.size) == edge
        assert not image.getexif()
        assert "exif" not in image.info and "icc_profile" not in image.info
        assert b"secret comment" not in data and b"PhoneMaker" not in data
    assert (result.width, result.height) == (1920, 1440)


def test_a_small_photo_is_never_enlarged() -> None:
    result = reencode_photo(jpeg((640, 480)))

    assert (result.width, result.height) == (640, 480)
    assert max(Image.open(io.BytesIO(result.thumb)).size) == THUMB_EDGE_PX


def test_the_orientation_is_applied_before_the_metadata_goes() -> None:
    # Orientation 6: the camera was turned; the stored photo must stand upright.
    result = reencode_photo(jpeg((800, 600), orientation=6))

    assert (result.width, result.height) == (600, 800)


_MEMORY_PROBE = """
import io, resource, sys
from PIL import Image
from src.core.images import reencode_photo
data = open(sys.argv[1], "rb").read()
tiny = io.BytesIO()
Image.new("RGB", (64, 48)).save(tiny, format="JPEG")
reencode_photo(tiny.getvalue())  # load the codecs
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
reencode_photo(data)
print((resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before) // 1024)
"""


@pytest.mark.skipif(sys.platform != "linux", reason="ru_maxrss is in KB on Linux only")
@pytest.mark.parametrize("progressive", [False, True])
def test_the_largest_accepted_photo_fits_the_memory_budget(
    progressive: bool, tmp_path: Path
) -> None:
    # docs/epics/E11_FILE_STORAGE.md section 4: measured 50-75 MB for 2560 px (about 30 MB for
    # the 1920 px a client sends); the backend's limit is 512 MB with one photo at a time.
    noise = Image.effect_noise((MAX_EDGE_PX, MAX_EDGE_PX * 3 // 4), 64).convert("RGB")
    source = tmp_path / "photo.jpg"
    noise.save(source, format="JPEG", quality=92, progressive=progressive)  # the worst case

    result = subprocess.run(
        [sys.executable, "-c", _MEMORY_PROBE, str(source)],
        cwd=Path(__file__).resolve().parents[2],  # the repository root, for `import src`
        capture_output=True,
        text=True,
        check=True,
    )

    assert int(result.stdout.strip()) < 100


def test_a_grayscale_or_cmyk_photo_is_accepted() -> None:
    assert reencode_photo(jpeg((300, 200), mode="L")).width == 300
    cmyk = io.BytesIO()
    Image.new("CMYK", (300, 200)).save(cmyk, format="JPEG")
    assert reencode_photo(cmyk.getvalue()).width == 300


def test_a_photo_larger_than_the_limit_is_refused_from_its_header() -> None:
    error = _error(jpeg((MAX_EDGE_PX + 1, 100)))

    assert (error.status_code, error.error_code) == (422, "IMAGE_TOO_LARGE")
    assert error.extra == {"max_edge_px": MAX_EDGE_PX}


def test_a_header_that_claims_a_huge_photo_is_refused_without_decoding() -> None:
    # A valid JPEG start with a frame header of 60000 x 60000 px and no image data: a bomb.
    data = bytearray(jpeg((16, 16)))
    sof = data.index(b"\xff\xc0")
    data[sof + 5 : sof + 9] = struct.pack(">HH", 60000, 60000)

    error = _error(bytes(data))

    assert error.error_code == "IMAGE_TOO_LARGE"


@pytest.mark.parametrize("image_format", ["PNG", "WEBP", "GIF", "BMP", "TIFF"])
def test_other_formats_are_never_decoded(image_format: str) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (50, 50)).save(buffer, format=image_format)

    error = _error(buffer.getvalue())

    assert (error.status_code, error.error_code) == (415, "UNSUPPORTED_MEDIA_TYPE")


def test_a_png_bomb_disguised_as_a_jpeg_is_refused_before_decoding() -> None:
    # A huge PNG of zeros compresses to a few kilobytes; it must never reach the PNG decoder.
    buffer = io.BytesIO()
    Image.new("1", (20000, 20000)).save(buffer, format="PNG")

    assert _error(buffer.getvalue()).error_code == "UNSUPPORTED_MEDIA_TYPE"


def test_a_cut_off_or_broken_jpeg_is_refused() -> None:
    data = jpeg((800, 600))

    assert _error(data[: len(data) // 2]).error_code == "INVALID_IMAGE"
    assert _error(b"\xff\xd8\xff" + b"\x00" * 100).error_code in {
        "INVALID_IMAGE",
        "UNSUPPORTED_MEDIA_TYPE",
    }
    assert _error(b"").error_code == "UNSUPPORTED_MEDIA_TYPE"


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + (len(payload) + 2).to_bytes(2, "big") + payload


def test_a_jpeg_with_endless_repeated_scans_is_refused_before_decoding() -> None:
    # A progressive JPEG whose last scan is repeated: libjpeg would decode it for minutes.
    data = jpeg((640, 480), progressive=True)
    last_scan = data.rindex(b"\xff\xda")
    scan = data[last_scan:-2]  # up to the end-of-image marker
    bomb = data[:-2] + scan * 200 + b"\xff\xd9"
    started = time.perf_counter()

    error = _error(bomb)

    assert error.error_code == "INVALID_IMAGE"
    assert time.perf_counter() - started < 0.5
    assert reencode_photo(data).width == 640  # the original itself is fine


def test_a_jpeg_padded_with_empty_metadata_segments_is_refused() -> None:
    data = jpeg((64, 48))
    padded = data[:2] + _segment(0xEF, b"") * 100_000 + data[2:]
    big_comment = data[:2] + _segment(0xFE, b"x" * 60_000) * 10 + data[2:]

    assert _error(padded).error_code == "INVALID_IMAGE"
    assert _error(big_comment).error_code == "INVALID_IMAGE"


def test_a_photo_with_a_colour_profile_is_converted_and_the_profile_dropped() -> None:
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    buffer = io.BytesIO()
    Image.new("RGB", (400, 300), "orange").save(buffer, format="JPEG", icc_profile=profile)

    result = reencode_photo(buffer.getvalue())

    stored = Image.open(io.BytesIO(result.display))
    assert "icc_profile" not in stored.info
    assert stored.size == (400, 300)


def test_a_broken_colour_profile_keeps_the_colours_and_never_fails() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (200, 100), "orange").save(buffer, format="JPEG", icc_profile=b"not a profile")

    result = reencode_photo(buffer.getvalue())

    assert "icc_profile" not in Image.open(io.BytesIO(result.display)).info


def test_endless_fill_bytes_before_a_marker_are_refused() -> None:
    data = jpeg((64, 48))

    assert _error(data[:2] + b"\xff" * 100_000 + data[2:]).error_code == "INVALID_IMAGE"
