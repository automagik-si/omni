# Omni Deployment

Omni ships a Helm umbrella chart — [`deploy/helm/omni`](helm/omni) — whose
bundled autopg Postgres, MinIO, and NATS services provide the supported
self-host shape.

## Public topology and ownership

The public promotion topology is a direct `dev` → `main` PR reviewed and merged
by a human. The `main` workflow is verification-only: it checks the already
published immutable candidate and cannot build, publish, retag, or change a
runtime.

`hml.omni.khal.ai` is the legacy HML endpoint.
This change neither mutates nor cleans it up. The endpoint and its HML runtime
and configuration files remain legacy/reference-only, not an active public
branch, image tag, release channel, or promotion gate. Production authority is
separate/private and is not defined by this repository's branches, workflows,
or legacy overlays.

## Supported public realm

| Realm | Cluster | Values file | Images | Database | Media | Who operates it |
|---|---|---|---|---|---|---|
| **dev / self-host** | Local or self-managed k8s (OrbStack, k3d, kind, …) | [`values-dev.yaml`](helm/omni/values-dev.yaml) | Locally built `omni-api:dev` + `autopg:dev` (`pullPolicy: Never`) or an explicitly selected public version | Bundled **autopg** subchart (Postgres 18, in-cluster) | Bundled **MinIO** (in-cluster S3) | The self-hoster |
| **HML** (`hml.omni.khal.ai`) | Private arm64 cluster | Private GitOps repo | Follows `dev` via `ghcr.io/automagik-dev/omni-api:dev-<sha12>` (built by `.github/workflows/image-dev.yml`: dispatch-only; no merge builds an image; legacy consumers retain their pin until an intentional dispatch and private pin update), pinned by digest in the private GitOps repo (`git.namastex.io/khal/deploy`) | Private | Private | The private GitOps repo (Argo CD) |
| **prod** | Private arm64 cluster | Private GitOps repo | Pinned to the verified candidate digest by the private GitOps repo; images are built on demand for a chosen version; software releases and public software pins do not imply an image exists | Private | Private | The private GitOps repo (Argo CD) |

- **One replica per installation** — a WhatsApp credential maps to a single live
  Baileys socket; see the "replicas + scaling" notes in
  [`values.yaml`](helm/omni/values.yaml) before scaling out.

## Self-hosting (the supported OSS path)

**The bundled autopg + MinIO + NATS stack — the `values-dev.yaml` shape — IS
the supported self-host path.** You do not need AWS, RDS, or an S3 account to
run Omni: `autopg.enabled: true` gives you an in-cluster Postgres 18 with
scoped-role provisioning, `minio.enabled: true` gives you an in-cluster S3 for
media, and NATS/JetStream is bundled as first-party templates. Legacy
external-datastore overlays are reference material, not part of the supported
public path; self-hosters can still select managed datastores through their own
values when they want managed durability.

Quickstart on any local/self-managed cluster:

```bash
# 1. Build the images (or use the public GHCR images — see below)
make -C deploy build          # omni-api:dev
make -C deploy build-autopg   # autopg:dev

# 2. Install (defaults: REALM=dev → values-dev.yaml, namespace omni)
make -C deploy deploy

# 3. Check it
make -C deploy status
make -C deploy health
```

To skip local builds entirely, point the dev-shape install at the public
registry images instead. The chart's `image.repository` and `image.tag` in
`deploy/helm/omni/values.yaml` point to the last verified image built on demand,
not to every software release. Neither `.well-known/latest.json` nor
`Chart.appVersion` guarantees a corresponding image exists:

```bash
IMAGE_TAG=$(awk '$1 == "tag:" {gsub(/"/, "", $2); print $2; exit}' deploy/helm/omni/values.yaml)
IMAGE_REPOSITORY=$(awk '$1 == "repository:" {print $2; exit}' deploy/helm/omni/values.yaml)
helm upgrade --install omni deploy/helm/omni -n omni --create-namespace \
  -f deploy/helm/omni/values-dev.yaml \
  --set image.repository="${IMAGE_REPOSITORY}" \
  --set image.tag="${IMAGE_TAG}" --set image.pullPolicy=IfNotPresent \
  --set autopg.image.repository=ghcr.io/automagik-dev/autopg \
  --set autopg.image.tag=v3.0.7 --set autopg.image.pullPolicy=IfNotPresent
```

Adjust `ingress.host`, the dev-only passwords, and `service.type` in a copy of
`values-dev.yaml` for anything beyond a throwaway install.

### Public images — no pull secret

`ghcr.io/automagik-dev/omni-api` and `ghcr.io/automagik-dev/autopg` are
**public**. Pulling them needs no registry credentials of any kind:
`imagePullSecrets` stays `[]` in every overlay, and nothing in this repo will
ever ask you to configure registry auth for these images.

Software releases are automatic; images are built only on demand. In Actions,
open `image-build.yml`, select the candidate tag in **Use workflow from**, and
optionally enter that same `v<version>` as `version`. An empty input selects the
newest stable candidate. A branch start fails with the newest tag to choose.

```bash
# Intentionally build a selected tag; run this only when an image is wanted.
gh workflow run image-build.yml --ref v<version> -f version=v<version>
```

The native amd64/arm64 build publishes one immutable version alias, verifies
its index/platforms and GitHub attestation, then dispatches the existing pin
writer in image-only mode. That writer updates only the Helm image repository
and tag. It never advances software pins, publishes npm, or deploys a cluster.
Every verified image is available for enterprise consumers to select by digest.
The chart advances when the image-only pin run succeeds; inspect that run if
an image build succeeded but the chart still names an older image.

Image provenance stays bound to the exact tag SHA and `image-build.yml` signer.
Software promotion verifies signed release tarballs and npm without requiring
an image. Tags predating the image-only workflow retain their historical workflow
copies; use a post-adoption candidate for the new on-demand behavior.

```bash
# Verify the chart's selected image, independent of the software channel pin.
gh attestation verify "oci://${IMAGE_REPOSITORY}:${IMAGE_TAG}" --repo <owner>/omni
```

### Proving the self-host path end-to-end

`deploy-smoke` spins up a fresh disposable k3d (or kind) cluster, imports the
locally built images, runs the full `values-dev.yaml` install with
`helm install --wait`, asserts every pod is Ready and `/health` answers, then
deletes the cluster — teardown runs even when the install fails, and the
target exits non-zero on failure:

```bash
make -C deploy deploy-smoke
```

Requires Docker running, `helm`, `kubectl`, and `k3d` or `kind` (auto-installs
k3d via Homebrew if neither is present). See the target header in
[`Makefile`](Makefile) for tunables (`SMOKE_TIMEOUT`, `SMOKE_SET`, …).

### Data safety & backups (self-host)

The bundled datastores hold real data — Postgres has your message history and the
**WhatsApp/Baileys session state** (lose it and every instance re-pairs), and
MinIO has media. Two things to set up:

1. **Backups** — [`backup/omni-backup.sh`](backup/) dumps Postgres (logical
   `pg_dump`, restore-verified) and mirrors the MinIO media to a local folder
   (`~/omni-backups` by default, Time Machine–friendly), with a matching
   [`backup/omni-restore.sh`](backup/). Nothing runs by default — wire it to
   `launchd` (macOS) or a `systemd` timer (Linux); see
   [`backup/README.md`](backup/README.md).

2. **PVC retention** — `values-dev.yaml` sets
   `persistentVolumeClaimRetentionPolicy: Retain` on the bundled StatefulSets, so
   the data PVCs survive a `helm uninstall`. But the StorageClass's **PV reclaim
   policy** is separate: on OrbStack/k3s `local-path` it defaults to `Delete`, so
   deleting the *PVC* (or the namespace) still erases the data dir. Flip the live
   PVs to `Retain` for a real safety net:

   ```bash
   for pv in $(kubectl get pv \
     -o jsonpath='{range .items[?(@.spec.claimRef.namespace=="omni")]}{.metadata.name}{"\n"}{end}'); do
     kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
   done
   ```

Local backups survive a cluster/OrbStack reset but not machine loss — keep
`~/omni-backups` under Time Machine, or copy it off-box.

## Makefile reference

Run everything as `make -C deploy <target>` from the repo root.

| Target | What it does |
|---|---|
| `build` | Build `omni-api:dev` (BuildKit, repo-root context) |
| `build-autopg` | Build `autopg:dev` from `autopg.Dockerfile` |
| `deps` | `helm dependency build` (vendors the autopg subchart) |
| `lint` / `template` | Lint / render the chart with the selected realm overlay |
| `deploy` | `helm upgrade --install --wait` to namespace `$(NAMESPACE)` |
| `redeploy` | Rebuild the image + `rollout restart` (repick the fixed `:dev` tag) |
| `status` / `logs` / `health` | Rollout status, API logs, port-forward + `GET /health` |
| `smoke` | Run the image alone in Docker (no cluster) |
| `deploy-smoke` | Full disposable-cluster install proof (see above) |
| `uninstall` | Remove the release |

The supported public path uses `REALM=dev`; `VALUES=…` can select a custom
self-host overlay. `HELM_EXTRA='--set …'` appends arbitrary Helm arguments,
and `NAMESPACE`/`RELEASE` default to `omni`.
