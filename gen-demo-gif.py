#!/usr/bin/env python3
"""Generate a terminal-style demo GIF for synth-loop."""

from PIL import Image, ImageDraw, ImageFont
import os

W, H = 900, 540
BG = (22, 27, 34)
FG = (171, 178, 191)
GREEN = (63, 185, 80)
YELLOW = (229, 192, 123)
CYAN = (56, 139, 253)
BOLD_CYAN = (97, 175, 239)
DIM = (92, 99, 112)
WHITE = (255, 255, 255)
RED = (248, 81, 73)

FONT_SIZE = 14
LINE_HEIGHT = 20
MARGIN_X = 30
MARGIN_Y = 20

frames = []


def get_font(bold=False):
    paths = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.ttf",
        "/Library/Fonts/Menlo.ttc",
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, FONT_SIZE if not bold else FONT_SIZE)
            except:
                continue
    return ImageFont.load_default()


font = get_font()
font_bold = get_font(True)

lines = [
    (0.0, "", FG, False),
    (
        0.1,
        "  synth-loop — recursive self-improvement for open-source projects",
        CYAN,
        True,
    ),
    (0.1, "  The AI that upgrades itself", DIM, False),
    (0.2, "", FG, False),
    (
        0.2,
        "$ npx @avasis-ai/synth-loop run ./synthcode --auto-publish --self-upgrade",
        YELLOW,
        True,
    ),
    (0.3, "", FG, False),
    (0.8, "  ============================================================", FG, True),
    (0.8, "  CYCLE #1 | v1.0.0 | Model: qwen3-coder-next:latest", BOLD_CYAN, True),
    (0.8, "  ============================================================", FG, True),
    (0.9, "", FG, False),
    (1.3, "  [1/7] DISCOVER", YELLOW, True),
    (1.5, "  Scanning anthropics/claude-code via GitHub API...", FG, False),
    (2.3, "  Context7: found 5 related libraries for claude-code", FG, False),
    (
        3.0,
        "  Extracted 14 patterns: agentic loop, tool use, streaming, permissions...",
        GREEN,
        False,
    ),
    (3.1, "", FG, False),
    (3.5, "  [2/7] ANALYZE", YELLOW, True),
    (3.7, "  Comparing 14 patterns against synthcode source...", FG, False),
    (
        4.3,
        "  Found 8 gaps: missing retry logic, no streaming abort, incomplete errors...",
        GREEN,
        False,
    ),
    (4.4, "  Top 3 selected for implementation", WHITE, True),
    (4.5, "", FG, False),
    (4.9, "  [3/7] IMPLEMENT", YELLOW, True),
    (5.1, "  Agent writing TypeScript changes...", FG, False),
    (5.6, "  + src/retry.ts (exponential backoff with jitter)", GREEN, False),
    (5.8, "  + src/stream-abort.ts (AbortController integration)", GREEN, False),
    (6.0, "  ~ src/errors.ts (added AgentTimeoutError, RateLimitError)", YELLOW, False),
    (6.2, "  + tests/retry.test.ts (12 test cases)", GREEN, False),
    (6.3, "", FG, False),
    (6.7, "  [4/7] SECURE", YELLOW, True),
    (6.9, "  Scanning diff for leaked secrets...", FG, False),
    (
        7.4,
        "  Security: PASS — no secrets, tokens, or credentials detected",
        GREEN,
        False,
    ),
    (7.5, "", FG, False),
    (7.9, "  [5/7] VERIFY", YELLOW, True),
    (8.1, "  tsc --noEmit ... PASS", GREEN, False),
    (8.4, "  npm test ... 95 passed, 0 failed", GREEN, False),
    (8.7, "  npm run build ... PASS", GREEN, False),
    (8.8, "", FG, False),
    (9.2, "  [6/7] PUBLISH", YELLOW, True),
    (9.4, "  Version bump: 1.0.0 -> 1.1.0", WHITE, True),
    (9.7, "  git push origin main ... OK", GREEN, False),
    (9.9, "  npm publish ... @avasis-ai/synthcode@1.1.0", GREEN, False),
    (10.0, "", FG, False),
    (10.3, "  [7/7] SELF-UPGRADE", YELLOW, True),
    (10.5, "  npm install @avasis-ai/synthcode@1.1.0 ... OK", GREEN, False),
    (10.6, "", FG, False),
    (10.7, "  Cycle complete — upgraded from 1.0.0 to 1.1.0", GREEN, True),
    (10.7, "  The improved version will be used for the next cycle.", DIM, False),
    (10.8, "", FG, False),
    (10.9, "  Starting cycle #2 in 60s...", DIM, False),
]

last_time = 0.0
current_lines = []

for ts, text, color, bold in lines:
    if ts > last_time:
        hold = int((ts - last_time) * 10)
        for _ in range(min(hold, 5)):
            frames.append(list(current_lines))
    if text:
        current_lines.append((text, color, bold))
    frames.append(list(current_lines))
    last_time = ts

for _ in range(20):
    frames.append(list(current_lines))

print(f"Generated {len(frames)} frames")

imgs = []
for frame_lines in frames:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    y = MARGIN_Y
    for text, color, bold in frame_lines:
        f = font_bold if bold else font
        draw.text((MARGIN_X, y), text, fill=color, font=f)
        y += LINE_HEIGHT
    imgs.append(img)

out = "/tmp/synth-loop/docs/demo.gif"
os.makedirs(os.path.dirname(out), exist_ok=True)
imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=150, loop=0)
print(f"Saved to {out} ({os.path.getsize(out)} bytes)")
