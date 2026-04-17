# Maina Verify Action

GitHub Action that runs [maina](https://maina.dev) verification on your pull requests, posts a **sticky root comment** (one per PR, updated in place), and emits a **GitHub Check Run** that branch protection can gate merges on.

## Usage

```yaml
name: Verify
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write   # sticky comment
  checks: write          # Check Run

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: mainahq/verify-action@v1
        with:
          token: ${{ secrets.MAINA_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

`github_token` is optional — if omitted, the action still runs the verification and sets outputs, it just skips posting to the PR. Drop the `permissions:` block too in that case.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `token` | Maina API token (from `maina login`) | Yes | |
| `base` | Base branch for diff comparison | No | `main` |
| `cloud_url` | Maina cloud API URL | No | `https://api.mainahq.com` |
| `github_token` | GitHub token for sticky comment + Check Run. Pass `${{ secrets.GITHUB_TOKEN }}`. | No | *(skip posting)* |

## Outputs

| Output | Description |
|--------|-------------|
| `passed` | Whether verification passed (`true`/`false`) |
| `findings_count` | Number of findings (errors + warnings) |
| `proof_url` | URL to the verification proof artifact |
| `report_url` | Public report permalink (`https://mainahq.com/r/<run-id>`) |
| `run_id` | Verification run id |

## What gets posted

When `github_token` is supplied and the workflow was triggered by a `pull_request` event:

1. **Sticky root comment** — one comment per PR, identified by an HTML marker. Re-runs update the same comment in place (no spam). Shows a findings table plus links to the full report.
2. **Check Run** (`maina/verification`) — conclusion is `success` or `failure`, up to 50 file-scoped findings are rendered as inline annotations, and `details_url` points at the public report. Branch protection required checks can gate merges on this.

Both are best-effort: a permission miss on one does not block the other.

## Example with outputs

```yaml
- uses: mainahq/verify-action@v1
  id: verify
  with:
    token: ${{ secrets.MAINA_TOKEN }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- run: echo "Report at ${{ steps.verify.outputs.report_url }}"
  if: always()
```
