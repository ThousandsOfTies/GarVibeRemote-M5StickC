#!/usr/bin/env bash
# GAR invokes this hook in the selected Linux build environment.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "${repo_root}/scripts/gar_target_artifact.py" "$@"
