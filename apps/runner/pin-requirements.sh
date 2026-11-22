#!/usr/bin/env bash
# Regenerates requirements.txt: the versions named below plus everything they
# pull in, each pinned by the SHA-256 of its wheel for both image platforms.
# The Python version must match the runner image's base (Dockerfile).
set -euo pipefail
PY=3.13
TOP=("numpy==2.5.5" "matplotlib==3.11.2")
cd "$(dirname "$0")"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for arch in x86_64 aarch64; do
  python3 -m pip download -q --only-binary=:all: --python-version "$PY" --implementation cp \
    --platform "manylinux_2_28_$arch" --platform "manylinux_2_17_$arch" --platform "manylinux2014_$arch" \
    -d "$tmp/$arch" "${TOP[@]}"
done
python3 - "$tmp" > requirements.txt <<'PY'
import collections, glob, hashlib, os, sys
hashes, version = collections.defaultdict(set), {}
for f in sorted(glob.glob(os.path.join(sys.argv[1], '*', '*.whl'))):
    name, v = os.path.basename(f).split('-')[:2]
    key = name.lower().replace('_', '-')
    version[key] = v
    hashes[key].add(hashlib.sha256(open(f, 'rb').read()).hexdigest())
print("# The runner image's Python packages: every one pinned by version and by the\n# SHA-256 of its wheel for linux/amd64 and linux/arm64 (pip --require-hashes).\n# Regenerate with apps/runner/pin-requirements.sh after changing a version.")
for k in sorted(hashes):
    print(f"{k}=={version[k]} \\\n" + " \\\n".join(f"    --hash=sha256:{h}" for h in sorted(hashes[k])))
PY
