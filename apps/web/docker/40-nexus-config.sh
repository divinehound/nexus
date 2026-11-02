#!/bin/sh
# Runs from the nginx image's entrypoint before nginx starts.
set -eu

# Where the API lives, e.g. http://api:4000/api. Its path must be /api, the API's global prefix.
api_url="${API_URL:-http://api:4000/api}"
scheme="${api_url%%://*}"
rest="${api_url#*://}"
hostport="${rest%%/*}"
host="${hostport%%:*}"
case "$hostport" in
  *:*) ;;
  *) if [ "$scheme" = https ]; then hostport="$hostport:443"; else hostport="$hostport:80"; fi ;;
esac

resolver="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)"
case "$resolver" in
  *:*) resolver="[$resolver]" ;;
  '') resolver=127.0.0.11 ;;
esac

sed -e "s#__API_HOSTPORT__#$hostport#" \
    -e "s#__API_SCHEME__#$scheme#" \
    -e "s#__API_HOST__#$host#" \
    -e "s#__RESOLVER__#$resolver#" \
    /etc/nginx/nexus.conf.template > /etc/nginx/conf.d/default.conf

# Browser config that should change without a rebuild. Only the characters an id can contain.
wc_id="$(printf '%s' "${WALLETCONNECT_PROJECT_ID:-${NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID:-}}" | tr -cd 'A-Za-z0-9_-')"
printf 'window.__NEXUS_CONFIG__ = { walletConnectProjectId: "%s" };\n' "$wc_id" > /usr/share/nginx/html/config.js
