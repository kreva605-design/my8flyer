#!/usr/bin/env python3
"""Convert a photo into a flat, mid-century-modern editorial poster illustration
using OpenAI's gpt-image-1 image-edit endpoint.

Usage:
    python3 process_photo.py <input_image> [-o OUTPUT] [--extra "..."] [--no-crop]

Requires the OPENAI_API_KEY environment variable.
"""
import argparse
import base64
import os
import sys
from pathlib import Path

import requests

STYLE_PROMPT = """Create a sophisticated editorial illustration with a strongly flattened, graphic composition.
The image should feel like a premium mid-century modern editorial poster, but with an even stronger emphasis on flat design, planar composition, and abstract graphic balance.

STYLE:
- extremely flat vector-like illustration
- strong planar composition
- geometric reduction of all objects
- minimal depth
- compressed space
- little to no perspective
- almost no volumetric modeling
- no realistic lighting
- no realistic shading
- color fields instead of rendered form
- bold silhouette-based design
- crisp edges
- poster-like visual structure
- elegant negative space
- graphic, intellectual, art-directed composition

IMPORTANT COMPOSITION RULE: Treat the entire image as a flat arrangement of shapes on a 2D surface. Do not build a realistic scene with deep space. Do not emphasize three-dimensional form. Flatten foreground, middle ground, and background into interlocking color planes.

VISUAL LANGUAGE:
- use overlapping geometric color blocks
- reduce objects into symbols and silhouettes
- simplify anatomy, faces, hands, buildings, furniture, plants, food, and vehicles into minimal flat shapes
- use cut-paper-like composition
- use screen-print / lithograph sensibility
- use strong cropping
- use asymmetrical balance
- use rhythmic placement of shapes
- use graphic repetition when helpful
- make the image feel like designed surface rather than observed reality

PERSPECTIVE:
- front-facing or near-flat viewpoint preferred
- top-down simplified view also acceptable
- avoid strong realistic perspective
- avoid deep spatial recession
- avoid cinematic depth

COLOR: Use a restrained but vivid palette of 4-6 colors. Examples: deep navy, warm ivory, vermilion red, cobalt blue, emerald or turquoise green, mustard yellow, coral pink.
Use 1-2 dominant colors and the rest as accents. Use solid flat fills. Minimal gradients only if absolutely necessary.

AVOID:
- photorealism
- 3D rendering
- realistic texture
- painterly realism
- cinematic lighting
- glossy digital finish
- excessive detail
- realistic cast shadows
- soft atmospheric depth
- anime style
- cute mascot look

DESIRED IMPRESSION: flat, graphic, planar, poster-like, editorial, stylized, designed, modernist, mature, visually striking, intellectually composed.

The final image should feel like a highly designed 2D graphic composition rather than a realistic illustration.

Reinterpret the subject(s) and composition of the provided photo in this style. No text unless specifically requested."""

API_URL = "https://api.openai.com/v1/images/edits"
API_SIZE = "1024x1536"  # closest supported size to a vertical 4:5
TARGET_RATIO = (4, 5)


def build_prompt(extra: str | None) -> str:
    if extra:
        return f"{STYLE_PROMPT}\n\nADDITIONAL NOTES FROM THE USER (content only, do not change the style rules above):\n{extra}"
    return STYLE_PROMPT


def call_openai_edit(api_key: str, image_path: Path, prompt: str) -> bytes:
    with open(image_path, "rb") as f:
        files = {"image": (image_path.name, f, "image/png")}
        data = {
            "model": "gpt-image-1",
            "prompt": prompt,
            "size": API_SIZE,
            "n": "1",
        }
        headers = {"Authorization": f"Bearer {api_key}"}
        resp = requests.post(API_URL, headers=headers, data=data, files=files, timeout=180)

    if resp.status_code != 200:
        raise RuntimeError(f"OpenAI API error {resp.status_code}: {resp.text}")

    payload = resp.json()
    b64 = payload["data"][0]["b64_json"]
    return base64.b64decode(b64)


def crop_to_ratio(png_bytes: bytes, ratio=TARGET_RATIO) -> bytes:
    try:
        from io import BytesIO
        from PIL import Image
    except ImportError:
        return png_bytes

    img = Image.open(BytesIO(png_bytes))
    w, h = img.size
    target_w, target_h = ratio
    target_h_px = round(w * target_h / target_w)

    if target_h_px <= h:
        top = (h - target_h_px) // 2
        img = img.crop((0, top, w, top + target_h_px))
    else:
        target_w_px = round(h * target_w / target_h)
        left = (w - target_w_px) // 2
        img = img.crop((left, 0, left + target_w_px, h))

    out = BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_image", type=Path, help="Path to the source photo")
    parser.add_argument("-o", "--output", type=Path, default=None, help="Output PNG path")
    parser.add_argument("--extra", type=str, default=None, help="Extra content-specific instructions")
    parser.add_argument("--no-crop", action="store_true", help="Skip cropping to exact 4:5")
    args = parser.parse_args()

    if not args.input_image.exists():
        print(f"Input image not found: {args.input_image}", file=sys.stderr)
        return 1

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY environment variable is not set.", file=sys.stderr)
        return 1

    output_path = args.output or args.input_image.with_name(
        args.input_image.stem + "_flat-editorial.png"
    )

    prompt = build_prompt(args.extra)
    png_bytes = call_openai_edit(api_key, args.input_image, prompt)

    if not args.no_crop:
        png_bytes = crop_to_ratio(png_bytes)

    output_path.write_bytes(png_bytes)
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
