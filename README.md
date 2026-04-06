# Maina Verify Action

GitHub Action that runs [maina](https://maina.dev) verification on your pull requests.

## Usage

```yaml
name: Verify
on:
  pull_request:
    branches: [main]

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
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `token` | Maina API token | Yes | |
| `base` | Base branch for diff comparison | No | `main` |
| `cloud_url` | Maina cloud API URL | No | `https://api.maina.dev` |

## Outputs

| Output | Description |
|--------|-------------|
| `passed` | Whether verification passed (`true`/`false`) |
| `findings_count` | Number of findings (errors + warnings) |
| `proof_url` | URL to the verification proof |

## Example with outputs

```yaml
- uses: mainahq/verify-action@v1
  id: verify
  with:
    token: ${{ secrets.MAINA_TOKEN }}

- run: echo "Proof at ${{ steps.verify.outputs.proof_url }}"
  if: always()
```
