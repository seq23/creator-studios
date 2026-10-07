#!/usr/bin/env bash
# Install apt packages on a GitHub runner without letting a hung mirror eat the job.
# 7 Oct 2026: `apt-get update` on the runners hung 8 and 18 minutes, then timed out twice; the
# selftest and the merge gate went red with no code at fault. Each try is bounded (network
# timeouts + a wall clock), the second try switches to the main Ubuntu archive, and a failure
# says so in one line instead of hanging.
set -uo pipefail
APT=(sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60)
for try in 1 2 3; do
  if [ "$try" -ge 2 ]; then
    # The runner's regional mirror (azure.archive.ubuntu.com) is the usual culprit: use the main archive.
    sudo sed -i 's#http://azure.archive.ubuntu.com#http://archive.ubuntu.com#g' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
  fi
  if timeout 150 "${APT[@]}" update -qq && timeout 300 "${APT[@]}" install -y -qq "$@" > /dev/null; then
    exit 0
  fi
  echo "apt-install: try $try failed (packages: $*)"
done
exit 1
