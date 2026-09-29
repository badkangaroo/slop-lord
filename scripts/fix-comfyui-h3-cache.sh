#!/usr/bin/env bash
# scripts/fix-comfyui-h3-cache.sh
#
# Fixes a version mismatch in the ComfyUI-MiniMaxH3-Cache custom node on the DGX Spark.
#
# PROBLEM
# ──────────────────────────────────────────────────────────────────────────────
# ComfyUI-MiniMaxH3-Cache monkey-patches MiniMax H3's final_layer.forward().
# The patch was written when final_layer.forward() took 4 positional args:
#   (self, h, t_emb, video_seg, audio_seg)
#
# ComfyUI core was later updated so the model calls it with 3 additional args:
#   (self, h, t_emb, video_seg, audio_seg, sigma, sample_sigmas, shifts)
#
# The Cache patch drops the 3 extra args, causing:
#   TypeError: FinalLayer.forward() missing 3 required positional arguments:
#              'sigma', 'sample_sigmas', and 'shifts'
#
# FIX
# ──────────────────────────────────────────────────────────────────────────────
# Add **kwargs to the Cache's patched_forward call so it accepts (and ignores)
# any extra positional/keyword arguments from the updated calling convention.
#
# Run this ON THE DGX SPARK (10.0.1.3) as the ComfyUI service user, or via SSH:
#   ssh <user>@10.0.1.3 'bash -s' < scripts/fix-comfyui-h3-cache.sh
#
# After running, restart ComfyUI for the fix to take effect.

set -euo pipefail

CACHE_NODE="/opt/ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Cache/__init__.py"

if [ ! -f "$CACHE_NODE" ]; then
  echo "ERROR: Cache node not found at $CACHE_NODE"
  echo "Adjust the path and try again."
  exit 1
fi

echo "Backing up original to ${CACHE_NODE}.bak ..."
cp "$CACHE_NODE" "${CACHE_NODE}.bak"

# The patched_forward call in the Cache node looks like:
#   v, a = self.final_layer(h, t_emb, video_seg, audio_seg)
# We need to change the inner call to forward extra args:
#   v, a = self.final_layer(h, t_emb, video_seg, audio_seg, *args, **kwargs)
# and update the outer function signature to accept *args, **kwargs.
#
# This sed replaces the patched_forward definition + the final_layer call:
python3 - "$CACHE_NODE" << 'PYEOF'
import sys, re

path = sys.argv[1]
src = open(path).read()

# Pattern 1: fix the patched_forward signature to accept *args/**kwargs
# Before: def patched_forward(self, h, t_emb, video_seg, audio_seg):
# After:  def patched_forward(self, h, t_emb, video_seg, audio_seg, *args, **kwargs):
src = re.sub(
    r'(def patched_forward\(self, h, t_emb, video_seg, audio_seg)\):',
    r'\1, *args, **kwargs):',
    src
)

# Pattern 2: fix the final_layer call to forward extra args
# Before: v, a = self.final_layer(h, t_emb, video_seg, audio_seg)
# After:  v, a = self.final_layer(h, t_emb, video_seg, audio_seg, *args, **kwargs)
src = re.sub(
    r'v, a = self\.final_layer\(h, t_emb, video_seg, audio_seg\)',
    r'v, a = self.final_layer(h, t_emb, video_seg, audio_seg, *args, **kwargs)',
    src
)

open(path, 'w').write(src)
print("Done. Changes applied to", path)
PYEOF

echo ""
echo "Fix applied. Please restart ComfyUI:"
echo "  sudo systemctl restart comfyui"
echo "  # or: pkill -f 'python.*main.py' && cd /opt/ComfyUI && python main.py --listen &"
