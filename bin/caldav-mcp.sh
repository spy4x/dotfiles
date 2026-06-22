#!/bin/sh
# caldav-mcp — native Deno CalDAV MCP server
# Reads CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD from env.
# Falls back to ~/.config/caldav-creds.env if vars not set.
# NEVER hardcode credentials in this file — they end up in git.

[ -z "$CALDAV_URL" ] && [ -f "$HOME/.config/caldav-creds.env" ] && . "$HOME/.config/caldav-creds.env"

: "${CALDAV_URL:?Must set CALDAV_URL or create ~/.config/caldav-creds.env}"
: "${CALDAV_USERNAME:?Must set CALDAV_USERNAME}"
: "${CALDAV_PASSWORD:?Must set CALDAV_PASSWORD}"

export CALDAV_URL CALDAV_USERNAME CALDAV_PASSWORD
export LOG_LEVEL="${LOG_LEVEL:-info}"

exec "$HOME/sync/code/caldav-mcp/caldav-mcp" "$@"
