"""
Builds the on-device food recognizer for PlateMeter.

Outputs (into app/src/main/assets/model/):
  image_encoder.onnx  - MobileCLIP2-S0 image encoder.
                        input  "pixels":    float32 [N, 256, 256, 3], RGB values 0-255
                        output "embedding": float32 [N, 512], L2-normalised
                        (resizing to 256x256 is done by the app; normalisation is baked in)
  labels.json         - every dish with its calories and its text embedding

Usage:
  python tools/build_model.py                 # real weights (downloads from Hugging Face)
  python tools/build_model.py --random        # random weights, only to test the pipeline
"""
import argparse
import json
import os
import sys

import numpy as np
import torch
import open_clip

MODEL = "MobileCLIP2-S0"
PRETRAINED = "dfndr2b"
SIZE = 256

TEMPLATES = [
    "a photo of {}.",
    "a close-up photo of {}, a type of food.",
    "a photo of {} served on a plate or in a bowl.",
]
NONFOOD_TEMPLATES = ["a photo of {}."]


class Encoder(torch.nn.Module):
    """Takes raw RGB pixels (N,H,W,3, 0-255) and returns normalised embeddings."""

    def __init__(self, visual, mean, std):
        super().__init__()
        self.visual = visual
        self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32).view(1, 3, 1, 1) * 255.0)
        self.register_buffer("std", torch.tensor(std, dtype=torch.float32).view(1, 3, 1, 1) * 255.0)

    def forward(self, pixels):
        x = pixels.permute(0, 3, 1, 2)
        x = (x - self.mean) / self.std
        e = self.visual(x)
        return e / e.norm(dim=-1, keepdim=True)


def reparameterize(model):
    # FastViT/MobileCLIP blocks can be fused into single convs for faster inference.
    try:
        from timm.utils.model import reparameterize_model
        return reparameterize_model(model)
    except Exception as exc:  # older/newer timm: run unfused, still correct
        print("reparameterize skipped:", exc)
        return model


@torch.no_grad()
def text_embedding(model, tokenizer, phrases, templates):
    texts = [t.format(p) for p in phrases for t in templates]
    e = model.encode_text(tokenizer(texts)).float()
    e = e / e.norm(dim=-1, keepdim=True)
    e = e.mean(dim=0)
    return (e / e.norm()).numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", action="store_true", help="random weights, for testing only")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "assets", "model"))
    args = ap.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, "foods.json"), encoding="utf-8") as f:
        spec = json.load(f)

    model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=None if args.random else PRETRAINED)
    model.eval()
    tokenizer = open_clip.get_tokenizer(MODEL)
    cfg = model.visual.preprocess_cfg
    mean, std = cfg["mean"], cfg["std"]
    if not args.random:
        # Trust the pretrained config; MobileCLIP2 expects mean 0 / std 1.
        pcfg = open_clip.get_pretrained_cfg(MODEL, PRETRAINED)
        mean, std = pcfg.get("mean", mean), pcfg.get("std", std)
    print("preprocess mean/std:", mean, std)

    os.makedirs(args.out, exist_ok=True)

    # ---- text side: one embedding per dish ----
    foods = []
    for item in spec["foods"]:
        emb = text_embedding(model, tokenizer, item["en"], TEMPLATES)
        foods.append({"zh": item["zh"], "kcal": item["kcal"], "g": item["g"],
                      "emb": [round(float(v), 5) for v in emb]})
    nonfood = []
    for item in spec["nonfood"]:
        for phrase in item["en"]:  # each phrase is its own prototype (plate vs bowl look different)
            emb = text_embedding(model, tokenizer, [phrase], NONFOOD_TEMPLATES)
            nonfood.append({"id": item["id"], "emb": [round(float(v), 5) for v in emb]})

    scale = float(model.logit_scale.exp().item()) if not args.random else 100.0
    labels = {"model": MODEL, "random": args.random, "size": SIZE, "dim": len(foods[0]["emb"]),
              "scale": round(min(scale, 100.0), 3), "foods": foods, "nonfood": nonfood}
    with open(os.path.join(args.out, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False, separators=(",", ":"))

    # ---- image side: ONNX export ----
    visual = reparameterize(model.visual).eval()
    enc = Encoder(visual, mean, std).eval()
    dummy = torch.randint(0, 256, (2, SIZE, SIZE, 3)).float()
    path = os.path.join(args.out, "image_encoder.onnx")
    torch.onnx.export(enc, dummy, path, input_names=["pixels"], output_names=["embedding"],
                      dynamic_axes={"pixels": {0: "n"}, "embedding": {0: "n"}},
                      opset_version=17, do_constant_folding=True, dynamo=False)

    # ---- self-check: ONNX matches PyTorch on the official preprocessing ----
    import onnxruntime as ort
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    with torch.no_grad():
        want = enc(dummy).numpy()
        ref = model.encode_image(((dummy.permute(0, 3, 1, 2) / 255.0) - torch.tensor(mean).view(1, 3, 1, 1))
                                 / torch.tensor(std).view(1, 3, 1, 1)).float()
        ref = (ref / ref.norm(dim=-1, keepdim=True)).numpy()
    got = sess.run(None, {"pixels": dummy.numpy()})[0]
    cos_onnx = float((got * want).sum(-1).min())
    cos_ref = float((got * ref).sum(-1).min())
    print(f"onnx vs torch cosine: {cos_onnx:.5f}  vs unfused model: {cos_ref:.5f}")
    if cos_onnx < 0.999 or cos_ref < 0.99:
        sys.exit("ONNX export does not match the PyTorch model")

    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path} ({mb:.1f} MB) and labels.json with {len(foods)} dishes")


if __name__ == "__main__":
    main()
