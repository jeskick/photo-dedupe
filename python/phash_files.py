"""Hash photo pixels down to a fingerprint so recompressed copies can be compared."""

import io
import json
import sys

from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:
    pass

import imagehash


def load_image(path):
    try:
        image = Image.open(path)
        image.draft("RGB", (128, 128))
        image = ImageOps.exif_transpose(image)
        return image
    except Exception:
        return load_embedded_jpeg(path)


def load_embedded_jpeg(path):
    with open(path, "rb") as handle:
        blob = handle.read(8 * 1024 * 1024)
    start = blob.find(b"\xff\xd8\xff")
    if start < 0:
        return None
    image = Image.open(io.BytesIO(blob[start:]))
    image = ImageOps.exif_transpose(image)
    return image


def fingerprint(path):
    image = load_image(path)
    if image is None:
        raise RuntimeError("无法读取画面")
    return str(imagehash.dhash(image.convert("L"), hash_size=8))


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            payload = {"path": path, "phash": fingerprint(path)}
        except Exception as error:
            payload = {"path": path, "error": str(error)}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
