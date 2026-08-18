# What the managed repos actually need

Survey run 16 Aug 2026, before any design work, to size the feature against
real workloads rather than an imagined one. Two questions: *do repos declare
services at all*, and *do they use testcontainers* (which no shared-namespace
design can serve).

## Method, and what it does not cover

GitHub code search over `org:nearform`, via the authenticated `gh` CLI. Three
caveats, all of which bias the counts **down**:

- Code search only returns repos the querying token can see — public, plus any
  private repo the account can read. Nearform has private repos not covered.
- **This is the `nearform` org, not the managed set.** `config/default.yaml`
  ships `managedRepos: []`; the effective list lives in the private
  `cliftonc/lastlight-instance` overlay, or is derived from GitHub App
  installations at boot. `GET /admin/api/managed-repos` on a running instance
  returns the real list — rerun the survey against it before treating these
  numbers as final.
- Code search indexing is neither instant nor exhaustive.

The index was live at survey time: a control query (`fastify` in
`filename:package.json`) returned 52 hits.

## Testcontainers: effectively zero

One hit across the entire org, and it is a **documentation mention**, not a
dependency: `skills/uw-analyze-integration-tests/SKILL.md` in
`nearform/unwind`. Zero hits in any `package.json`.

This matters because testcontainers creates containers *programmatically from
test code*, which requires a Docker socket inside the sandbox — a socket is
root on the host, and no design in this plan grants one. Had the number been
material, the plan's scope would have been wrong. It is not: these are largely
Fastify-ecosystem Node libraries, and that ecosystem uses CI services rather
than testcontainers.

## CI services: eight repos, one shape

`"services:" path:.github/workflows` → 8 repos.

| Repo | Service | Image | Notable |
|---|---|---|---|
| `sql` | postgres | `postgres:${{ matrix.postgres-version }}-alpine` | matrix-interpolated |
| `temporal_tables` | postgres | `${{ matrix.pg }}` | **10-version matrix** |
| `fastify-mssql` | mssql | `mcr.microsoft.com/mssql/server:2017-CU8-ubuntu` | non-Docker-Hub registry |
| `fastify-secrets-hashicorp` | vault | `vault:1.6.2` | |
| `fastify-slow-down` | redis | `redis` | bare tag, no digest |
| `the-graphql-workshop` | postgres | `postgres:alpine` | ports `5433:5432` |
| `owasp-top-ten-workshop` | postgres | `postgres:alpine` | ports `5434:5432` |
| `the-fastify-workshop` | postgres | `postgres:alpine` | ports `5433:5432` |

Workload: 5× postgres, 1× redis, 1× mssql, 1× vault. **Every one declares
exactly one service**, and **every one uses `options: --health-cmd`**.

## Four observations that shaped the design

**1. Matrix interpolation is 25% of the sample.** `sql` and `temporal_tables`
both derive the image from a matrix, and `temporal_tables` matrixes across ten
postgres versions (9.5 → 17). Any scheme that *derives* the service set from
CI has to answer "which one?" with no defensible default. This is the finding
that eliminated deriving-from-CI as the declaration source — see the README's
decision 1.

**2. Docker Hub is not the only registry.** `fastify-mssql` pulls from
`mcr.microsoft.com`. An operator image allowlist expressed as
`docker.io/library/*` would silently drop it. The allowlist must be
registry-qualified from the first version.

**3. Port remapping is 37% of the sample, and it is not vestigial.**
`the-graphql-workshop` also ships its own `docker-compose.yml` publishing
`5433:5432`. The CI remap exists so the same connection string works in local
development and in CI — the application's config genuinely expects 5433.
Normalising every service onto its native port would break these three repos.
This is why the design carries Actions' `ports:` form verbatim and translates
it, rather than declaring the remap unnecessary.

**4. Health checks are universal.** All eight use `--health-cmd`. Readiness is
not an edge case to bolt on later; "container started" is not "accepts
connections", and every repo in the sample already says so.

## Reproducing the survey

```bash
gh api "search/code?q=org:nearform+testcontainers" --jq '.total_count'
gh api "search/code?q=org:nearform+%22services%3A%22+path:.github/workflows" \
  --jq '.items[].repository.full_name' | sort -u
```

Against the real managed list instead of the org:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<instance>/admin/api/managed-repos | jq -r '.effective[]'
```
