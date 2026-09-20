#!/usr/bin/env sh

set -eu

export GNUPGHOME="${GNUPGHOME:-/proton/gnupg}"
export HOME="${HOME:-/tmp}"
export PASSWORD_STORE_DIR="${PASSWORD_STORE_DIR:-/proton/pass}"
export PROTON_DRIVE_CACHE_DIR="${PROTON_DRIVE_CACHE_DIR:-/proton/cache}"
export PROTON_DRIVE_CREDENTIALS_STORE="pass"
export PROTON_DRIVE_LOG_LEVEL="WARNING"

mkdir -p "${GNUPGHOME}" "${PASSWORD_STORE_DIR}" "${PROTON_DRIVE_CACHE_DIR}"
chmod 0700 "${GNUPGHOME}" "${PASSWORD_STORE_DIR}" "${PROTON_DRIVE_CACHE_DIR}"

if ! gpg --batch --list-secret-keys backup-runner@localhost >/dev/null 2>&1; then
    gpg --batch \
        --passphrase '' \
        --quick-generate-key \
        'Backup Runner <backup-runner@localhost>' \
        ed25519 \
        sign \
        0
fi

key_id="$(gpg --batch --with-colons --list-secret-keys backup-runner@localhost | awk -F: '$1 == "sec" { print $5; exit }')"
if [ -z "${key_id}" ]; then
    printf 'Could not find the Proton session encryption key\n' >&2
    exit 1
fi

if [ ! -f "${PASSWORD_STORE_DIR}/.gpg-id" ]; then
    pass init "${key_id}"
fi

exec proton-drive auth login
