#!/bin/sh
# Generate (or report) the passphrase that encrypts the state bus files.
#
# The dashboard reads it from this file; the GitHub Actions runner gets the
# same value as the STATE_KEY repository secret. Keep it out of the repo.
set -e

DIR="${HOME}/.config/minecraft-bot-runner"
FILE="${DIR}/state.key"

mkdir -p "$DIR"

if [ ! -f "$FILE" ]; then
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > "$FILE"
  chmod 600 "$FILE"
  echo "wrote ${FILE}"
else
  echo "already exists: ${FILE}"
fi

echo
echo "Local dashboard: nothing to do, it reads that file."
echo "CI runner:       gh secret set STATE_KEY -R <owner>/<repo> \"\$(cat ${FILE})\""
