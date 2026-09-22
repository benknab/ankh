#!/bin/sh

case "$1" in
  *Username*) printf '%s\n' oauth2 ;;
  *Password*)
    [ -r "$GITEA_TOKEN_FILE" ] || exit 1
    printf '%s\n' "$(cat "$GITEA_TOKEN_FILE")"
    ;;
  *) exit 1 ;;
esac
