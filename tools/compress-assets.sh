#!/usr/bin/env bash
# Compresses image/audio assets in place. Re-run after adding new sprites or
# audio so load size stays in check.
#
# PNGs: oxipng lossless recompression (always applied, zero quality loss)
# followed by pngquant palette quantization at quality>=85 with
# --skip-if-larger, so a file is only touched if pngquant can hit that
# quality floor AND the result is smaller than the oxipng-only version.
# Anything pngquant can't do losslessly-enough to (e.g. soft gradients that
# would band) is left at its oxipng-only size.
#
# MP3s: only files encoded well above what a short game SFX/music loop
# needs (>=224kbps) are re-encoded, down to a bitrate matched to their role
# (music vs one-shot SFX). Files already at a sane bitrate are left alone —
# re-encoding an already-modest mp3 only adds transcoding generation loss
# for negligible size gain.
#
# node tools/... scripts in this repo use CDP; this one is plain shell since
# it only shells out to oxipng/pngquant/lame.
set -euo pipefail
cd "$(dirname "$0")/.."

PNG_QUALITY="85-100"
total_before=0
total_after=0

echo "== PNGs =="
while IFS= read -r -d '' f; do
  before=$(stat -f%z "$f")
  oxipng -o4 --strip safe -q "$f"
  tmp="${f%.png}.pq.png"
  if pngquant --quality="$PNG_QUALITY" --speed 1 --strip --skip-if-larger --force \
       --output "$tmp" "$f" 2>/dev/null; then
    oxipng -o4 --strip safe -q "$tmp"
    mv "$tmp" "$f"
  else
    rm -f "$tmp"
  fi
  after=$(stat -f%z "$f")
  total_before=$((total_before + before))
  total_after=$((total_after + after))
  if [ "$before" -ne "$after" ]; then
    printf "  %6dK -> %6dK  %s\n" $((before/1024)) $((after/1024)) "$f"
  fi
done < <(find assets -iname "*.png" -print0)
printf "PNG total: %dK -> %dK\n\n" $((total_before/1024)) $((total_after/1024))

echo "== MP3s (re-encoding only files >=224kbps) =="
mp3_before=0
mp3_after=0
while IFS= read -r -d '' f; do
  kbps=$(lame --decode "$f" /dev/null 2>&1 | grep -oE "[0-9]+ kbps" | sort -u -n | tail -1 | grep -oE "[0-9]+")
  [ -z "$kbps" ] && continue
  if [ "$kbps" -lt 224 ]; then
    continue
  fi
  before=$(stat -f%z "$f")
  case "$f" in
    assets/music/*) target="-V2";;   # ~170-210kbps VBR, transparent for music
    *)               target="-V3";;  # ~150-195kbps VBR, plenty for short SFX
  esac
  tmp="${f%.mp3}.re.mp3"
  lame --silent $target "$f" "$tmp"
  after=$(stat -f%z "$tmp")
  if [ "$after" -lt "$before" ]; then
    mv "$tmp" "$f"
  else
    rm -f "$tmp"
    after=$before
  fi
  mp3_before=$((mp3_before + before))
  mp3_after=$((mp3_after + after))
  printf "  %6dK -> %6dK  %s (%skbps -> %s)\n" $((before/1024)) $((after/1024)) "$f" "$kbps" "$target"
done < <(find assets -iname "*.mp3" -print0)
printf "MP3 (re-encoded set) total: %dK -> %dK\n" $((mp3_before/1024)) $((mp3_after/1024))
