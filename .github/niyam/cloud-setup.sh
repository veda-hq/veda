#!/bin/bash
# niyam 0.6.14 for Claude cloud sessions: Node 24.21.0 and the CLI, as niyam on PATH.
# niyam onboard writes this file at the version .github/workflows/niyam.yml pins, and writes it again on every run.
# The cloud environment's Setup script runs it, from what niyam cloud-setup prints, and so does
# session-start when the environment holds another release. Change it by running onboard, not by hand.
set -euo pipefail
dir=/opt/niyam
node=24.21.0
case "$(uname -m)" in x86_64) arch=x64 sum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;; aarch64 | arm64) arch=arm64 sum=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;; *) echo "niyam: no Node for $(uname -m)" >&2; exit 1 ;; esac
bin="$dir/node-v$node-linux-$arch/bin/node"
mkdir -p "$dir"
if [ "$("$bin" --version 2>/dev/null)" != "v$node" ]; then
  curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/node.tar.xz" "https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz"
  echo "$sum  $dir/node.tar.xz" | sha256sum -c --quiet -
  tar -xJ -f "$dir/node.tar.xz" -C "$dir"
  rm "$dir/node.tar.xz"
fi
curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/niyam.tgz" https://github.com/veda-hq/niyam/releases/download/v0.6.14/veda-hq-niyam-0.6.14.tgz
echo "94a7d10644a8949b29fed51c04c00754f209b8608a1a1c194c96084e95647d28  $dir/niyam.tgz" | sha256sum -c --quiet -
cli="$dir/cli-0.6.14"
rm -rf "$cli"
mkdir -p "$cli"
tar -xz -f "$dir/niyam.tgz" -C "$cli"
rm "$dir/niyam.tgz"
rm -f /usr/local/bin/niyam /usr/local/bin/process-rules
printf '#!/bin/sh\nexec %s %s "$@"\n' "$bin" "$cli/package/dist/cli.js" > /usr/local/bin/niyam
chmod 755 /usr/local/bin/niyam
if [ -n "${NIYAM_SETUP:-}" ]; then printf '%s\n' "$0" > /opt/niyam/from-setup; fi
niyam version </dev/null
