#!/bin/sh

[ -n "$GITEA_ORIGIN" ] || exit 1
scheme=${GITEA_ORIGIN%%://*}
authority=${GITEA_ORIGIN#*://}

case "$1" in
  "Username for '$GITEA_ORIGIN': "*) printf '%s\n' oauth2 ;;
  "Password for '$GITEA_ORIGIN': "*|"Password for '$scheme://oauth2@$authority': "*)
    [ -r "$GITEA_TOKEN_FILE" ] || exit 1
    printf '%s\n' "$(cat "$GITEA_TOKEN_FILE")"
    ;;
  *) exit 1 ;;
esac
