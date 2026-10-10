"""本机识别人脸、动物和风景。结果只供浏览标记，不参与删除。"""

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "data" / "models"
YOLO_PATH = MODEL_DIR / "yolo11s.onnx"
YOLO_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11s.onnx"
ANIMAL = {14, 15, 16, 17, 18, 19, 20, 21, 22, 23}
# 鸟、熊、象这些在溪水、石头和人身上经常误报。狗、猫、马、牛更可信。
SUSPECT_ANIMAL = {14, 18, 20, 21, 22, 23}
RELIABLE_ANIMAL = {15, 16, 17, 19}
# 椅子、床、手机这些室内物体，以及车船，都不是风景。盆栽留在外面，花园仍可算风景。
INDOOR = {56, 57, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79}
VEHICLE = {1, 2, 3, 4, 5, 6, 7, 8}
PERSON_SCORE = 0.25
ANIMAL_SCORE = 0.75
OBJECT_SCORE = 0.45
PERSON_ANIMAL_OVERLAP = 0.45
MIN_SUBJECT = 2500


def load_rgb(path, limit):
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass
    image = Image.open(path)
    image.thumbnail((limit, limit))
    return image.convert("RGB")


def ensure_yolo():
    if YOLO_PATH.exists() and YOLO_PATH.stat().st_size > 1000000:
        return True
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(YOLO_URL, YOLO_PATH)
    except Exception:
        return False
    return YOLO_PATH.exists() and YOLO_PATH.stat().st_size > 1000000


def box_iou(left, right):
    def edges(box):
        cx, cy, width, height = (float(value) for value in box)
        return cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2

    ax1, ay1, ax2, ay2 = edges(left)
    bx1, by1, bx2, by2 = edges(right)
    overlap_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    overlap_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = overlap_w * overlap_h
    union = max(0.0, float(left[2])) * max(0.0, float(left[3])) + max(0.0, float(right[2])) * max(0.0, float(right[3])) - inter
    return inter / union if union > 0 else 0.0


def box_area(box):
    return max(0.0, float(box[2])) * max(0.0, float(box[3]))


def nms(found, limit=0.5):
    ordered = sorted(found, key=lambda item: item[0], reverse=True)
    kept = []
    for score, kind, box in ordered:
        if any(kind == old_kind and box_iou(box, old_box) >= limit for _score, old_kind, old_box in kept):
            continue
        kept.append((score, kind, box))
    return kept


def scene_labels(rgb, session):
    if session is None:
        return []
    size = 640
    width, height = rgb.size
    scale = size / max(width, height)
    resized = rgb.resize((max(1, int(width * scale)), max(1, int(height * scale))))
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(resized, (0, 0))
    blob = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255
    output = session.run(None, {session.get_inputs()[0].name: blob})[0]
    pred = output[0]
    if pred.shape[0] < pred.shape[-1]:
        pred = pred.T
    raw = []
    blocked = False
    for row in pred:
        scores = row[4:]
        kind = int(scores.argmax())
        score = float(scores[kind])
        if kind == 0 and score >= PERSON_SCORE:
            raw.append((score, kind, row[:4]))
        elif kind in ANIMAL and score >= ANIMAL_SCORE:
            raw.append((score, kind, row[:4]))
        elif (kind in VEHICLE or kind in INDOOR) and score >= OBJECT_SCORE:
            blocked = True
    people = []
    animals = []
    for _score, kind, box in nms(raw):
        if box_area(box) < MIN_SUBJECT:
            continue
        if kind == 0:
            people.append(box)
        elif kind in ANIMAL:
            animals.append((kind, box))
    found = set()
    if people:
        found.add("person")
    for kind, box in animals:
        if people and kind in SUSPECT_ANIMAL:
            continue
        if any(box_iou(box, person) >= PERSON_ANIMAL_OVERLAP for person in people):
            continue
        found.add("animal")
        break
    if not found and not blocked:
        found.add("landscape")
    return sorted(found)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    emit({"status": "正在准备分类"})
    try:
        import onnxruntime as ort
    except Exception as error:
        sys.stderr.write(f"分类组件还没装好：{error}\n")
        sys.exit(1)
    paths = []
    for raw in sys.stdin:
        path = raw.strip()
        if path:
            paths.append(path)
    if not ensure_yolo():
        sys.stderr.write("风景分类模型没准备好\n")
        sys.exit(1)
    session = ort.InferenceSession(str(YOLO_PATH), providers=["CPUExecutionProvider"])
    emit({"status": "正在区分风景"})
    people = []
    for path in paths:
        try:
            labels = scene_labels(load_rgb(path, 640), session)
            if "person" in labels:
                people.append((path, labels))
            emit({"path": path, "faces": [], "labels": labels, "pass": "scene"})
        except Exception as error:
            emit({"path": path, "error": str(error), "faces": [], "labels": [], "pass": "scene"})
    if not people:
        return
    emit({"status": "正在准备人物模型", "faceTotal": len(people)})
    try:
        import cv2
        from insightface.app import FaceAnalysis
    except Exception as error:
        sys.stderr.write(f"人物识别组件还没装好：{error}\n")
        sys.exit(1)
    faces_app = FaceAnalysis(name="buffalo_l", root=str(MODEL_DIR / "insightface"), providers=["CPUExecutionProvider"])
    faces_app.prepare(ctx_id=-1, det_thresh=0.35, det_size=(640, 640))
    emit({"status": "正在识别人物", "faceTotal": len(people)})
    for path, labels in people:
        try:
            rgb = load_rgb(path, 1280)
            bgr = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
            detected = faces_app.get(bgr)
            embeddings = []
            for face in detected:
                box = getattr(face, "bbox", None)
                area = 0.0
                if box is not None and len(box) >= 4:
                    area = max(0.0, float(box[2]) - float(box[0])) * max(0.0, float(box[3]) - float(box[1]))
                embeddings.append({
                    "embedding": face.normed_embedding.astype(np.float32).tolist(),
                    "area": area,
                })
            kept = [item for item in labels if item != "landscape"]
            if "person" not in kept:
                kept.append("person")
            emit({"path": path, "faces": embeddings, "labels": kept, "pass": "face"})
        except Exception as error:
            emit({"path": path, "error": str(error), "faces": [], "labels": ["person"], "pass": "face"})


if __name__ == "__main__":
    main()
