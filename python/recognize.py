"""本机识别人脸、动物和风景。结果只供浏览标记，不参与删除。"""

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "data" / "models"
YOLO_PATH = MODEL_DIR / "yolov8n.onnx"
YOLO_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx"
ANIMAL = {14, 15, 16, 17, 18, 19, 20, 21, 22, 23}


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
    found = set()
    for row in pred:
        scores = row[4:]
        kind = int(scores.argmax())
        score = float(scores[kind])
        if kind == 0 and score >= 0.30:
            found.add("person")
        elif kind in ANIMAL and score >= 0.45:
            found.add("animal")
    if "person" not in found:
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
            embeddings = [face.normed_embedding.astype(np.float32).tolist() for face in detected]
            kept = [item for item in labels if item != "landscape"]
            if "person" not in kept:
                kept.append("person")
            emit({"path": path, "faces": embeddings, "labels": kept, "pass": "face"})
        except Exception as error:
            emit({"path": path, "error": str(error), "faces": [], "labels": ["person"], "pass": "face"})


if __name__ == "__main__":
    main()
