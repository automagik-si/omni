#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 - "${ROOT}" <<'PY'
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

workflow = (Path(sys.argv[1]) / ".github/workflows/image-build.yml").read_text()
match = re.search(r"      - name: Create the immutable version index\n.*?        run: \|\n(.*?)(?=\n      - name:)", workflow, re.S)
assert match, "missing real merge step"
script = "\n".join(line[10:] for line in match[1].splitlines())
digest = "sha256:" + "c" * 64

with tempfile.TemporaryDirectory(prefix="native-image-merge-") as scratch:
    base = Path(scratch)
    binary = base / "bin"
    binary.mkdir()
    docker = binary / "docker"
    docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
pathlib.Path(os.environ["CALLS"]).write_text(json.dumps(args))
assert args[:3] == ["buildx", "imagetools", "create"], args
if os.environ["CASE"] == "create-fails":
    sys.exit(1)
metadata = pathlib.Path(args[args.index("--metadata-file") + 1])
value = {} if os.environ["CASE"] == "missing-metadata-digest" else {"containerimage.descriptor": {"digest": os.environ["MERGED_DIGEST"]}}
metadata.write_text(json.dumps(value))
''')
    docker.chmod(0o755)
    for case in ("valid", "missing-arm64", "invalid-arm64", "create-fails", "missing-metadata-digest", "invalid-index-digest"):
        work = base / case
        (work / "digests").mkdir(parents=True)
        amd64 = "sha256:" + "a" * 64
        arm64 = "sha256:" + "b" * 64
        (work / "digests/amd64").write_text(amd64 + "\n")
        if case != "missing-arm64":
            (work / "digests/arm64").write_text(("bad;tag" if case == "invalid-arm64" else arm64) + "\n")
        output = work / "output"
        calls = work / "calls"
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env={
            **os.environ,
            "PATH": str(binary) + os.pathsep + os.environ["PATH"],
            "RUNNER_TEMP": str(work), "GITHUB_OUTPUT": str(output),
            "IMAGE": "registry.invalid/example/image", "VERSION": "1.2.3",
            "CASE": case, "CALLS": str(calls),
            "MERGED_DIGEST": "invalid" if case == "invalid-index-digest" else digest,
        })
        if case == "valid":
            assert result.returncode == 0, result.stderr
            assert output.read_text() == f"digest={digest}\n"
            assert json.loads(calls.read_text()) == [
                "buildx", "imagetools", "create", "--tag", "registry.invalid/example/image:v1.2.3",
                "--metadata-file", str(work / "merge-metadata.json"),
                f"registry.invalid/example/image@{amd64}", f"registry.invalid/example/image@{arm64}",
            ], "merge must create exactly one version alias from both digest references"
        else:
            assert result.returncode != 0, f"{case} was accepted"
            assert not output.exists(), f"{case} emitted a trusted digest"
            if case in ("missing-arm64", "invalid-arm64"):
                assert not calls.exists(), f"{case} reached a registry mutation"
print("PASS: actual index merge binds both platform digests and fails closed on missing/invalid inputs or metadata")
PY
