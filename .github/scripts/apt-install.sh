#!/usr/bin/env bash
# Install apt packages on a GitHub runner without letting a hung mirror eat the job.
# 7 Oct 2026: `apt-get update` on the runners hung 8 and 18 minutes, then timed out twice; the
# selftest and the merge gate went red with no code at fault. Each try is bounded (network
# timeouts + a wall clock), the second try switches to the main Ubuntu archive, and a failure
# says so in one line instead of hanging.
set -uo pipefail
APT=(sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60)
# 23 Oct 2026: every try timed out at the install step (update passed) on 4 of 6 runs in an hour,
# with nothing in the log. Two changes: man-db's trigger (it rebuilds the manual index after every
# install, minutes on a runner) is switched off, and a failed try prints the tail of apt's own output
# so the next failure names its cause.
sudo rm -f /var/lib/man-db/auto-update 2>/dev/null || true
LOG=$(mktemp)
for try in 1 2 3; do
  if [ "$try" -ge 2 ]; then
    # The runner's regional mirror (azure.archive.ubuntu.com) is the usual culprit: use the main archive.
    sudo sed -i 's#http://azure.archive.ubuntu.com#http://archive.ubuntu.com#g' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
  fi
  if timeout 150 "${APT[@]}" update -qq > "$LOG" 2>&1 && timeout 300 "${APT[@]}" install -y -qq --no-install-recommends "$@" >> "$LOG" 2>&1; then
    exit 0
  fi
  echo "apt-install: try $try failed (packages: $*); last lines:"
  tail -n 12 "$LOG" | sed 's/^/  apt: /'
  sudo pkill -9 -f 'apt-get|dpkg' 2>/dev/null || true
  sudo dpkg --configure -a 2>/dev/null || true
done
exit 1
