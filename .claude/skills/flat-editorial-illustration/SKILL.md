---
name: flat-editorial-illustration
description: Transform a photo into a flat, mid-century-modern editorial poster illustration — extremely flat vector-like style, planar composition, geometric reduction, 4-6 color flat fields, no realistic shading/lighting/perspective. Use when the user asks to "turn this photo into a flat/graphic/poster-style illustration", references this specific editorial illustration style, or wants a photo processed/converted into a stylized flat design image. Requires OPENAI_API_KEY (uses gpt-image-1).
---

# Flat Editorial Illustration

Converts an input photo into a highly flattened, planar, poster-like editorial
illustration using OpenAI's `gpt-image-1` image-edit model. The style prompt is
fixed (mid-century-modern editorial poster, extreme flat design, geometric
reduction, 4-6 color palette, vertical 4:5) and lives in `scripts/process_photo.py`
so results stay consistent across runs.

## Requirements

- `OPENAI_API_KEY` environment variable must be set. If it is not set, ask the
  user for it (or tell them how to export it) before running the script —
  do not guess or hardcode a key.
- Python 3 with the `requests` package. `Pillow` is optional but recommended
  (used only to crop the result to an exact vertical 4:5 — without it the
  script keeps the raw 1024x1536 output from the API).

## Usage

Run the script (found at `scripts/process_photo.py`, relative to this
SKILL.md's own directory — resolve that path first, since this skill may be
installed either under `~/.claude/skills/` or inside a project's
`.claude/skills/`) with the path to the source photo:

```bash
python3 <path-to-this-skill>/scripts/process_photo.py <input_image> [-o OUTPUT] [--extra "extra instructions"] [--no-crop]
```

- `<input_image>`: path to the photo to convert (jpg/png/webp).
- `-o OUTPUT`: output file path. Defaults to `<input>_flat-editorial.png` next
  to the source file.
- `--extra "..."`: optional free text appended to the fixed style prompt, for
  when the user wants to steer subject-specific details (e.g. "keep the dog
  in the center", "make the sky mustard yellow instead of ivory"). Do not use
  this to change the core style — only for content-specific notes.
- `--no-crop`: skip the local crop-to-4:5 step and keep the API's native
  output dimensions (1024x1536).

The script prints the final output path on success. Show/send that file to
the user when done (e.g. via whatever file-sending mechanism the current
environment provides).

## Notes for the agent

- `gpt-image-1`'s edit endpoint doesn't support an exact 4:5 size, so the
  script requests the closest supported size (1024x1536, i.e. 2:3) and then
  center-crops to 4:5 locally with Pillow when available. Mention this to the
  user only if they ask about exact pixel dimensions.
- If the user wants a different aspect ratio or a non-photo starting point
  (pure text-to-image, no source photo), that's outside this skill's script —
  use the OpenAI images *generate* endpoint instead, reusing the same prompt
  text from `scripts/process_photo.py`.
- One photo in, one stylized image out per run. For batches, call the script
  once per file.
