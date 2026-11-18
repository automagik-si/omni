# Public release and image readiness

Software releases are automatic. Container images are built only on demand.
Production deployment authority remains separate/private; these workflows do
not deploy a cluster or move a private production pin.

## Automatic software publication

Every eligible merged PR to `dev` triggers the version bump. That bump starts
`release-candidate.yml`, which:

1. Calls `version.yml` with `candidate=true` to cut an immutable candidate tag,
   without publishing that candidate as npm `next` or a dev prerelease.
2. Dispatches `release-stable.yml` at the exact candidate tag and watches it.
3. Pins the verified software metadata on `dev` through `pin-candidate.yml`.

`release-stable.yml` retains the protected `release` environment, exact tag and
source binding, immutable tag ruleset, existing release inventory/signature
verification, and bounded npm retries. It publishes the stable GitHub release
through `release.yml`, then the stable `@automagik/omni` npm package through
`version.yml`, then dispatches the software pin. Its receipt records the source,
version and release timestamp independently of npm success.

The software pin writes `.well-known/latest.json`, `.well-known/dev.json`, and
`marketplace/automagik.json`. It does not inspect an image or change Helm's image
selection. The reusable fallback pin in `release-candidate.yml` runs only after
stable software publication succeeds. Both paths use the existing serialized
`version-dev` writer and are idempotent.

No automatic software workflow dispatches `image-build.yml` or `image-dev.yml`.
A `no-release` PR still skips automatic versioning. The merged-PR npm `next`
path remains separate from stable candidate publication.

## Read-only main promotion

A human reviews and merges a direct `dev` → `main` promotion PR.
The Promotion Pin Gate and `image-publish.yml` bind the promoted tree to its
immutable version tag and source, verify signed GitHub release assets and
GitHub-native tarball provenance, and verify exact stable npm state.
They never require a container image. Protected source-input drift checks
remain in `scripts/release/verify-promotion-candidate.sh`.

Promotion neither builds nor publishes artifacts, moves aliases or refs,
changes a runtime, nor grants production deployment authority.

## Recovering a failed orchestrated release

The candidate summary links the tag-bound `release-stable.yml` run. Find it with:

```bash
gh run list --workflow release-stable.yml --branch v<version>
```

Rerun the failed jobs of that software orchestrator, or the failed mint job in
`release-candidate.yml`. The latter resumes the existing software run for the
same source. Existing stable release assets and npm package bytes are verified
before reuse; an existing version is never overwritten. Once stable npm is
verified, the software pin is dispatched again and commits nothing if current.

Stable publishers use `verify-orchestrator-run.py` to require the exact
in-progress, tag-bound `release-stable.yml` dispatch. A child publication rerun
when its parent completed is refused; recover the parent instead.

Only transient registry failures receive bounded retries: readback convergence,
tarball propagation and publish 5xx errors. A publish PUT 404 can indicate an
authorization refusal and is not retried as propagation.

## On-demand release images

Open `image-build.yml` in Actions and select the candidate tag in **Use workflow
from**. The optional `version` input is a `v<version>` tag; empty means the newest
stable candidate. The workflow must start at that same tag so the GitHub
attestation certificate binds the build to the selected source SHA. A branch
start refuses with one line naming the newest candidate tag to pick.

```bash
# Intentional operation only; software publication never runs this command.
gh workflow run image-build.yml --ref v<version> -f version=v<version>
```

The native matrix builds amd64 on `ubuntu-latest` and arm64 on
`ubuntu-24.04-arm`. Platform jobs push by digest without BuildKit cache imports
or exports. `merge` repeats the immutable source/package/chart and alias-absence
preflight, creates exactly one version index, captures its digest from Buildx
metadata, reads the alias back, and attests it. Final verification checks the
exact index digest, both platforms and GitHub provenance before handing off the
image-only pin. The image workflow never publishes npm or a GitHub release.

`pin-candidate.yml` with `image_only=true` verifies the image's tag/source and
attestation and writes only Helm's image repository and tag. The chart's
`image.tag` therefore points to the last verified image built on demand, not to
every software release. It advances when that pin run succeeds. Enterprise
consumers can select every built image by its immutable digest; private rollout
and production pins remain operator-controlled.

An already-published image version is refused. If verification or pin dispatch
fails after the alias was created, rerun failed jobs of the same image run;
never rebuild or move that version alias. The pin itself can be rerun without
rebuilding. Default and explicit requests serialize the merge by resolved
version so they cannot overwrite the same alias.

Use a candidate cut after the image-only workflow was adopted. The new workflow
refuses a selected tag without that workflow, but immutable older tags still
contain the historical workflow copy. A direct dispatch at such an old tag runs
that historical code; this change cannot retrofit or disable it.

The path-filtered `image-native-check.yml` PR guard remains a native build check
only: local OCI output, no login, registry push, secrets or attestations. Its
compilation inputs match the release build. Registry pushes, index publication,
attestation and the image pin require proof from a real intentional image run.

## Optional dev images

`image-dev.yml` is dispatch-only. It builds an exact commit on `dev`, or its
current head when no ref is supplied, and produces the `dev-<sha12>` and `dev`
aliases. It is never part of the automatic version job. Legacy/private consumers
retain their existing digest until an intentional dispatch and private pin update.

## npm publisher configuration

The automatic stable path publishes only `@automagik/omni`. Its npm trusted
publisher is GitHub Actions, owner `automagik-si`, repository `omni`, workflow
filename `version.yml`, with environment left blank: the npm publisher job has
no environment. The protected parent `release-stable.yml` does not execute
`npm publish`. Package metadata must name the same canonical repository.

The investigated publisher runs failed at npm's publish PUT with E404 after
image production, authorization and package build had succeeded. That is a
publish authorization failure rather than an image dependency or a tarball
propagation failure. The canonical GitHub repository redirects from its former
owner; a stale trusted-publisher binding is a leading inference, not a verified
account setting. The package repository URL is corrected in code. An owner must
check npmjs.com settings separately; no token/settings changes or publication
attempts are part of this change.

The standalone `@omni/sdk` publisher is manual and outside this release chain;
its token-based setup remains unchanged.
