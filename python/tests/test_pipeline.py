import json
import os

import cv2
import numpy as np
import pytest
import tifffile

import raw_pipeline as rp

# (cx, cy, radius) of the synthetic sensor dust shadows
DUST = [(400, 300, 14), (900, 500, 22), (1400, 800, 9), (700, 900, 30)]
WIDTH, HEIGHT = 1800, 1200


def make_sky_png(path: str) -> None:
    rng = np.random.default_rng(1)
    y = np.linspace(0, 1, HEIGHT)[:, None]
    sky = 150 + 60 * y + rng.normal(0, 0.8, (HEIGHT, WIDTH))
    img = np.dstack([sky * 0.80, sky * 0.92, sky * 1.0]).astype(np.float32)
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    for cx, cy, r in DUST:
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        shade = 1 - 0.09 * np.clip(1 - d / r, 0, 1) ** 0.6
        img *= shade[:, :, None]
    bgr = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    assert cv2.imwrite(path, bgr)


@pytest.fixture(scope="module")
def session(tmp_path_factory):
    root = tmp_path_factory.mktemp("sc")
    src = str(root / "sky.png")
    make_sky_png(src)
    session_dir = str(root / "session")
    meta = rp.ingest_image(src, session_dir)
    detection = rp.detect_sensor_dust(session_dir, {})
    return {"dir": session_dir, "meta": meta, "detection": detection}


def test_ordinary_image_is_not_marked_as_raw(session):
    assert session["meta"]["isRaw"] is False
    assert session["meta"]["decodeKind"] == "image-8bit"
    assert session["meta"]["fullWidth"] == WIDTH


def test_detects_every_synthetic_dust_spot(session):
    spots = session["detection"]["spots"]
    for cx, cy, _ in DUST:
        nearest = min(np.hypot(s["cx"] - cx, s["cy"] - cy) for s in spots)
        assert nearest < 8, f"no detection near ({cx}, {cy}); nearest was {nearest:.1f}px"


def test_inpaint_heals_dust_and_leaves_distant_pixels_untouched(session):
    params = {
        "spots": session["detection"]["spots"],
        "manualStrokes": [],
        "inpaintRadius": 6,
        "preserveGrain": True,
    }
    result = rp.inpaint_16bit_linear(session["dir"], params)
    assert result["healedSpotsCount"] == len(session["detection"]["spots"])

    original = np.load(os.path.join(session["dir"], "linear_16bit.npy")).astype(np.float64)
    healed = np.load(os.path.join(session["dir"], "inpainted_16bit.npy")).astype(np.float64)

    for cx, cy, r in DUST:
        half = int(r * 2.2) + 30
        ring = np.hypot(*np.mgrid[-half:half + 1, -half:half + 1])
        ys, xs = slice(cy - half, cy + half + 1), slice(cx - half, cx + half + 1)
        background = original[ys, xs, 1][(ring > r * 2.2) & (ring < r * 2.2 + 25)].mean()
        before = original[cy - 2:cy + 3, cx - 2:cx + 3, 1].mean()
        after = healed[cy - 2:cy + 3, cx - 2:cx + 3, 1].mean()
        assert abs(after - background) < abs(before - background) * 0.3

    far = (slice(1050, 1150), slice(100, 200))
    assert np.array_equal(original[far], healed[far])


def test_export_writes_non_ascii_file_names(session, tmp_path):
    out = str(tmp_path / "하늘_사진_cleaned.jpg")
    info = rp.export_healed_image(session["dir"], "jpg", out)
    assert os.path.getsize(out) == info["fileSizeBytes"] > 0
    decoded = cv2.imdecode(np.fromfile(out, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape[:2] == (HEIGHT, WIDTH)


def test_session_directory_with_non_ascii_path(tmp_path):
    src = str(tmp_path / "하늘.png")
    make_sky_png(os.path.join(str(tmp_path), "plain.png"))
    os.replace(os.path.join(str(tmp_path), "plain.png"), src)
    session_dir = str(tmp_path / "세션")
    meta = rp.ingest_image(src, session_dir)
    assert meta["fullWidth"] == WIDTH
    assert os.path.exists(os.path.join(session_dir, "preview_original.jpg"))


def _libraw_fails(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("LibRaw cannot read this file")

    monkeypatch.setattr(rp.rawpy, "imread", boom)


def test_single_channel_mosaic_is_rejected_when_libraw_fails(tmp_path, monkeypatch):
    _libraw_fails(monkeypatch)
    fake_raw = str(tmp_path / "mosaic.dng")
    tifffile.imwrite(fake_raw, np.random.default_rng(0).integers(0, 4096, (64, 64), dtype=np.uint16))
    with pytest.raises(ValueError, match="RAW"):
        rp.ingest_image(fake_raw, str(tmp_path / "session"))


def test_8bit_tiff_fallback_is_flagged_as_embedded_preview(tmp_path, monkeypatch):
    _libraw_fails(monkeypatch)
    fake_raw = str(tmp_path / "preview_only.dng")
    rgb = np.random.default_rng(0).integers(0, 255, (64, 64, 3), dtype=np.uint8)
    tifffile.imwrite(fake_raw, rgb, photometric="rgb")
    meta = rp.ingest_image(fake_raw, str(tmp_path / "session"))
    assert meta["isRaw"] is True
    assert meta["decodeKind"] == "embedded-preview"


def test_session_meta_is_json_serialisable(session):
    json.dumps(session["meta"])
