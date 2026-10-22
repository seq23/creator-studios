#!/usr/bin/env bash
# A static ffmpeg on a GitHub runner without apt (the runners' apt mirror hung 7 Oct and 22 Oct 2026,
# and FedericoCarboni/setup-ffmpeg broke upstream 22 Oct 2026): the BtbN GPL build from GitHub
# releases (libx264, freetype for drawtext), put on PATH. Falls back to the bounded apt installer.
set -uo pipefail
URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
if curl -fsSL --retry 3 --max-time 180 -o /tmp/ffmpeg.tar.xz "$URL" && mkdir -p /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1; then
  echo "/tmp/ffmpeg/bin" >> "${GITHUB_PATH:-/dev/null}"
  exit 0
fi
echo "ffmpeg-static: download failed; using apt"
exec bash "$(dirname "$0")/apt-install.sh" ffmpeg
