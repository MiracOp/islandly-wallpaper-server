#!/usr/bin/env bash
#
# Islandly exact-profile Live Photo wallpaper generator.
#
# Usage:
#   ./canli-duvar-kagidi.sh video.mp4
#   ./canli-duvar-kagidi.sh video.mp4 neon-sehir
#   ./canli-duvar-kagidi.sh video.mp4 neon-sehir 4.5
#
# Output:
#   cikti/<name>.heic
#   cikti/<name>.mov
#   cikti/<name>-thumb.jpg
#
# Profile:
#   1080x1920, HEVC hvc1, 60 fps, exactly 55 frames (550/600 s)
#   plus the two camera-derived Apple metadata tracks required by iOS.
#
# Metadata generator adapted from apple-video-to-livephotos (MIT),
# Copyright (c) 2026 Teuku Fadhlul.

set -euo pipefail

TARGET_W=1080
TARGET_H=1920
FPS=60
FRAME_COUNT=55
CRF=20
THUMB_W=420
OUT_DIR="${OUT_DIR:-cikti}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_GENERATOR="$SCRIPT_DIR/apple-livephoto-generator.swift"
METADATA_TEMPLATE="$SCRIPT_DIR/livephoto-metadata.mov"

R=$'\033[0m'; B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; E=$'\033[31m'
info() { printf "%s▸%s %s\n" "$C" "$R" "$1"; }
ok()   { printf "%s✓%s %s\n" "$G" "$R" "$1"; }
warn() { printf "%s!%s %s\n" "$Y" "$R" "$1"; }
die()  { printf "%s✗%s %s\n" "$E" "$R" "$1" >&2; exit 1; }

for tool in ffmpeg ffprobe exiftool swift sips; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool kurulu değil."
done

[ -f "$SWIFT_GENERATOR" ] || die "Swift üretici eksik: $SWIFT_GENERATOR"
[ -f "$METADATA_TEMPLATE" ] || die "Apple metadata şablonu eksik: $METADATA_TEMPLATE"
[ $# -ge 1 ] || die "Kullanım: $0 <video> [isim] [başlangıç-saniyesi]"

SRC="$1"
[ -f "$SRC" ] || die "Dosya bulunamadı: $SRC"

NAME="${2:-}"
if [ -z "$NAME" ]; then
  NAME=$(basename "${SRC%.*}" | tr '[:upper:]' '[:lower:]' | tr ' _' '--' | tr -cd 'a-z0-9-')
fi
[ -n "$NAME" ] || NAME="wallpaper"
START="${3:-0}"

mkdir -p "$OUT_DIR"
MOV="$OUT_DIR/$NAME.mov"
HEIC="$OUT_DIR/$NAME.heic"
THUMB="$OUT_DIR/$NAME-thumb.jpg"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/islandly-livephoto.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

PREPARED="$WORK_DIR/prepared.mov"
STILL="$WORK_DIR/still.jpg"

SRC_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")
SRC_W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$SRC")
SRC_H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SRC")
printf "\n%sKaynak%s  %s\n" "$B" "$R" "$SRC"
printf "        %sx%s · %.3f sn\n\n" "$SRC_W" "$SRC_H" "$SRC_DUR"

awk -v d="$SRC_DUR" -v s="$START" 'BEGIN { exit (s >= 0 && s < d) ? 0 : 1 }' \
  || die "Başlangıç zamanı video aralığında değil."

info "MyScreen benzeri profile dönüştürülüyor: 1080x1920 · 60 fps · 55 kare"
ffmpeg -v error -y -stream_loop -1 -ss "$START" -i "$SRC" \
  -vf "scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${TARGET_W}:${TARGET_H},fps=${FPS},trim=end_frame=${FRAME_COUNT},setpts=N/(${FPS}*TB)" \
  -frames:v "$FRAME_COUNT" -an \
  -c:v libx265 -preset medium -crf "$CRF" -pix_fmt yuv420p -tag:v hvc1 \
  -video_track_timescale 600 -movflags +faststart "$PREPARED"

ACTUAL_FRAMES=$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "$PREPARED")
ACTUAL_DURATION=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$PREPARED")
[ "$ACTUAL_FRAMES" = "$FRAME_COUNT" ] || die "Kare sayısı yanlış: $ACTUAL_FRAMES"
awk -v d="$ACTUAL_DURATION" 'BEGIN { exit (d > 0.9166 && d < 0.9168) ? 0 : 1 }' \
  || die "Video süresi yanlış: $ACTUAL_DURATION"
ok "Video profili doğrulandı: $ACTUAL_FRAMES kare · $ACTUAL_DURATION sn"

info "Ana kare çıkarılıyor"
ffmpeg -v error -y -ss 0.45 -i "$PREPARED" -frames:v 1 -q:v 1 -update 1 "$STILL"

info "Apple Live Photo metadata kanalları ekleniyor"
swift "$SWIFT_GENERATOR" "$STILL" "$PREPARED" "$METADATA_TEMPLATE" "$HEIC" "$MOV"

IMAGE_ID=$(exiftool -s3 -Apple:ContentIdentifier "$HEIC" 2>/dev/null || true)
VIDEO_ID=$(exiftool -s3 -Keys:ContentIdentifier "$MOV" 2>/dev/null || true)
[ -n "$IMAGE_ID" ] || die "HEIC kimliği okunamadı."
[ "$IMAGE_ID" = "$VIDEO_ID" ] || die "HEIC ve MOV kimlikleri eşleşmiyor."

DATA_TRACKS=$(ffprobe -v error -select_streams d -show_entries stream=index -of csv=p=0 "$MOV" | wc -l | tr -d ' ')
[ "$DATA_TRACKS" -ge 2 ] || die "Apple metadata kanalları eksik."

sips -s format jpeg -Z "$THUMB_W" "$HEIC" --out "$THUMB" >/dev/null
ok "Eşleşme doğrulandı: $IMAGE_ID"
ok "$HEIC"
ok "$MOV"
ok "$THUMB"

printf "\n%sHazır%s  %s\n" "$B$G" "$R" "$NAME"
printf "        1080x1920 · 60 fps · 55 kare · %s metadata kanalı\n" "$DATA_TRACKS"
printf "\nSunucu kayıt alanları:\n"
printf "  stillURL: /media/%s.heic\n" "$NAME"
printf "  videoURL: /media/%s.mov\n" "$NAME"
printf "  thumbURL: /media/%s-thumb.jpg\n\n" "$NAME"
