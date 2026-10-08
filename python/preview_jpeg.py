"""Turn a photo, including HEIC, TIFF, and RAW with an embedded preview, into a JPEG."""

import io
import sys

from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:
    pass


def load_embedded_jpeg(path):
    with open(path, "rb") as handle:
        blob = handle.read(12 * 1024 * 1024)
    start = blob.find(b"\xff\xd8\xff")
    if start < 0:
        return None
    return Image.open(io.BytesIO(blob[start:]))


def load_image(path):
    try:
        return Image.open(path)
    except Exception:
        return load_embedded_jpeg(path)


def main():
    image = load_image(sys.argv[1])
    if image is None:
        raise RuntimeError("无法读取画面")
    edge = 1600
    if len(sys.argv) > 2:
        try:
            edge = int(sys.argv[2])
        except ValueError:
            edge = 1600
    edge = max(64, min(1600, edge))
    image = ImageOps.exif_transpose(image)
    if image.mode != "RGB":
        image = image.convert("RGB")
    image.thumbnail((edge, edge))
    image.save(sys.stdout.buffer, format="JPEG", quality=82)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)
