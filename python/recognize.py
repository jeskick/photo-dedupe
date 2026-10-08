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
YOLO_URL = "https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.onnx"
ANIMAL = {14, 15, 16, 17, 18, 19, 20, 21, 22, 23}
INDOOR = {56, 57, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75}


def load_rgb(path):
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass
    image = Image.open(path)
    image.thumbnail((1280, 1280))
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
    indoor = False
    for row in pred:
        scores = row[4:]
        kind = int(scores.argmax())
        if float(scores[kind]) < 0.4:
            continue
        if kind == 0:
            found.add("person")
        elif kind in ANIMAL:
            found.add("animal")
        elif kind in INDOOR:
            indoor = True
    if "person" not in found and "animal" not in found and not indoor:
        found.add("landscape")
    return sorted(found)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    emit({"status": "正在准备人物模型，第一次会下载到本机"})
    try:
        import cv2
        import onnxruntime as ort
        from insightface.app import FaceAnalysis
    except Exception as error:
        sys.stderr.write(f"人物识别组件还没装好：{error}\n")
        sys.exit(1)
    faces_app = FaceAnalysis(name="buffalo_s", root=str(MODEL_DIR / "insightface"), providers=["CPUExecutionProvider"])
    faces_app.prepare(ctx_id=-1, det_size=(640, 640))
    emit({"status": "正在准备风景和动物模型"})
    session = None
    if ensure_yolo():
        session = ort.InferenceSession(str(YOLO_PATH), providers=["CPUExecutionProvider"])
    emit({"status": "正在识别全部照片"})
    for raw in sys.stdin:
        path = raw.strip()
        if not path:
            continue
        try:
            rgb = load_rgb(path)
            bgr = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
            detected = faces_app.get(bgr)
            embeddings = [face.normed_embedding.astype(np.float32).tolist() for face in detected]
            labels = scene_labels(rgb, session)
            if embeddings and "person" not in labels:
                labels.append("person")
            if "person" in labels or "animal" in labels:
                labels = [item for item in labels if item != "landscape"]
            print(json.dumps({"path": path, "faces": embeddings, "labels": labels}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"path": path, "error": str(error), "faces": [], "labels": []}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
