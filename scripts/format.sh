#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
flags=(-i)
if [[ $# -gt 0 ]]; then
    if [[ $# -ne 1 || $1 != --check ]]; then
        echo "Usage: $0 [--check]" >&2
        exit 2
    fi
    flags=(--dry-run --Werror)
fi
cd -- "$root"
find src -type f \
    \( -name '*.c' -o -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' \
    -o -name '*.h' -o -name '*.hpp' -o -name '*.hh' -o -name '*.hxx' \) -print0 |
    xargs -0 -r clang-format-22 "${flags[@]}"
