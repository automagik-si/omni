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

root = Path(sys.argv[1])
image = (root / ".github/workflows/image-build.yml").read_text()
pin = (root / ".github/workflows/pin-candidate.yml").read_text()

def step(workflow, name):
    block = workflow.split(f"      - name: {name}\n", 1)[1].split("\n      - ", 1)[0]
    body = block.split("        run: |\n", 1)[1]
    lines = []
    for line in body.splitlines():
        if line.strip() and not line.startswith("          "):
            break
        lines.append(line[10:])
    return "\n".join(lines)

def run(script, work, **extra):
    return subprocess.run(["bash", "-c", script], cwd=work, capture_output=True, text=True,
                          env={**os.environ, "PATH": str(work / "bin") + os.pathsep + os.environ["PATH"],
                               "RUNNER_TEMP": str(work), "GITHUB_OUTPUT": str(work / "output"),
                               "GITHUB_REPOSITORY": "example/repository", **extra})

with tempfile.TemporaryDirectory(prefix="software-image-split-") as scratch:
    base = Path(scratch)
    for case in ("latest-tag", "explicit-tag", "branch", "wrong-sha", "pre-adoption"):
        work = base / case
        (work / "bin").mkdir(parents=True)
        gh = work / "bin/gh"
        gh.write_text('''#!/usr/bin/env python3
import base64, os, sys
path = sys.argv[2]
if path.endswith("releases/latest"):
    print("v1.2.3")
elif "/commits/" in path:
    print("a" * 40)
elif "/contents/" in path:
    name = "Historical image publisher" if os.environ["CASE"] == "pre-adoption" else "Build release image on demand"
    print(base64.b64encode(f"name: {name}\\n".encode()).decode())
else:
    raise SystemExit("unexpected GitHub call")
''')
        gh.chmod(0o755)
        result = run(step(image, "Resolve version and exact source"), work,
                     CASE=case, REQUESTED_VERSION="v1.2.3" if case == "explicit-tag" else "",
                     GITHUB_EVENT_NAME="workflow_dispatch",
                     GITHUB_REF="refs/heads/dev" if case == "branch" else "refs/tags/v1.2.3",
                     GITHUB_SHA=("b" if case == "wrong-sha" else "a") * 40)
        if case in ("latest-tag", "explicit-tag"):
            assert result.returncode == 0, result.stderr
            assert (work / "output").read_text() == f'version=1.2.3\nsha={"a" * 40}\n'
        else:
            assert result.returncode != 0, f"{case} accepted"
            assert not (work / "output").exists(), f"{case} emitted a trusted source"
            if case == "branch":
                assert "v1.2.3" in result.stdout and "Use workflow from" in result.stdout

    # Execute each real mutation step against disposable files. Software
    # publication must leave Helm untouched; image pinning must leave both
    # software manifests and the plugin index untouched.
    for mode in ("software", "image"):
        work = base / mode
        (work / "bin").mkdir(parents=True)
        for path in (".well-known", "deploy/helm/omni", "marketplace"):
            (work / path).mkdir(parents=True)
        for name in ("latest", "dev"):
            (work / f".well-known/{name}.json").write_text(json.dumps({
                "version": "1.0.0", "released_at": "2026-01-01T00:00:00Z", "tarball_base": "old"}, indent=2))
        chart = work / "deploy/helm/omni/values.yaml"
        chart.write_text('image:\n  repository: registry.invalid/previous/image\n  tag: "v1.0.0"\n')
        (work / "marketplace/index.json").write_text('{}')
        before = {str(p.relative_to(work)): p.read_text() for p in work.rglob("*") if p.is_file()}
        for tool in ("gh", "docker", "git"):
            executable = work / "bin" / tool
            executable.write_text('#!/usr/bin/env bash\n' +
                                  ('printf "sha256:%064d\\n" 0\n' if tool == "docker" else 'exit 0\n'))
            executable.chmod(0o755)
        name = "Write the public channel pins" if mode == "software" else "Verify and pin the on-demand image in Helm"
        result = run(step(pin, name), work, VERSION="1.2.3", PUBLISHED_AT="2026-01-02T00:00:00Z",
                     SOURCE_SHA="a" * 40, IMAGE="registry.invalid/example/image")
        assert result.returncode == 0, result.stderr
        changed = {path for path, value in before.items() if (work / path).read_text() != value}
        assert changed == ({".well-known/latest.json", ".well-known/dev.json"} if mode == "software"
                           else {"deploy/helm/omni/values.yaml"}), (mode, changed)
        if mode == "image":
            assert "registry.invalid/example/image" in chart.read_text()
        else:
            assert json.loads((work / ".well-known/latest.json").read_text())["version"] == "1.2.3"

print("PASS: actual tag selection and disjoint software/image pin writes")
PY
