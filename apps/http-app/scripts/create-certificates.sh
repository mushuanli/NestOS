#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
Usage: create-certificates.sh [--cert-host IP_OR_DNS,...] [--cert-dir DIRECTORY]

Creates a local CA, server certificate, enrolled browser certificate and PKCS#12 package.
Default host: 127.0.0.1 (localhost is always included).
Default directory: ~/.config/mindos/http-certs (must not already exist).
Import ca.crt as a trusted CA and browser-client.p12 as a personal certificate.
The import password is saved in client-password.txt; secrets are never printed.
Requires pnpm, installed workspace dependencies, Node.js >=22.13 and OpenSSL.
HELP
    exit 0
fi

command -v openssl >/dev/null || { echo 'OpenSSL is required.' >&2; exit 1; }
command -v pnpm >/dev/null || { echo 'pnpm is required.' >&2; exit 1; }

# Preserve the caller's directory for relative --cert-dir paths.
export INIT_CWD="${INIT_CWD:-$PWD}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$script_dir/../../.."
exec pnpm --filter @itookit/http-app exec tsx src/server/main.ts --init-certs "$@"
