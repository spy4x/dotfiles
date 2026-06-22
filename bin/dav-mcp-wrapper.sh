#!/bin/sh
# dav-mcp-wrapper — npx dav-mcp with VTODO patch + local Radicale
# Reads CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD from env.
# Falls back to ~/.config/caldav-creds.env if vars not set.
# NEVER hardcode credentials in this file — they end up in git.

[ -z "$CALDAV_URL" ] && [ -f "$HOME/.config/caldav-creds.env" ] && . "$HOME/.config/caldav-creds.env"

: "${CALDAV_URL:?Must set CALDAV_URL or create ~/.config/caldav-creds.env}"
: "${CALDAV_USERNAME:?Must set CALDAV_USERNAME}"
: "${CALDAV_PASSWORD:?Must set CALDAV_PASSWORD}"

export CALDAV_SERVER_URL="$CALDAV_URL"
export CALDAV_USERNAME CALDAV_PASSWORD

# Cache dav-mcp via npx if not already cached
npx -y dav-mcp --help > /dev/null 2>&1 || true

# Patch broken VTODO methods in local npx cache (same fix as Docker entrypoint)
# tsdav has createCalendarObject/fetchCalendarObjects (defaults VEVENT), not fetchTodos
# We need to: replace method names + add VTODO filter to list-todos.js and todo-query.js
NPX_CACHE=$(find "$HOME/.npm/_npx" -maxdepth 1 -type d 2>/dev/null | head -5)
for dir in $NPX_CACHE /root/.npm/_npx; do
  [ -d "$dir" ] || continue
  # Fix method names in all todo files
  find "$dir" -path "*/dav-mcp/src/tools/todos/*.js" 2>/dev/null | while read -r f; do
    sed -i 's/client\.createTodo(/client.createCalendarObject(/g' "$f"
    sed -i 's/client\.deleteTodo(/client.deleteCalendarObject(/g' "$f"
    sed -i 's/client\.updateTodo(/client.updateCalendarObject(/g' "$f"
    sed -i 's/client\.todoMultiGet(/client.calendarMultiGet(/g' "$f"
    # fetchTodos needs special treatment - default filter is VEVENT, need VTODO filter
    sed -i 's/client\.fetchTodos(/client.fetchCalendarObjects(/g' "$f"
  done
  # Add VTODO filter to list-todos.js and todo-query.js (they now call fetchCalendarObjects)
  # The line looks like: const todos = await client.fetchCalendarObjects({ calendar });
  # We need to replace { calendar } with { calendar, filters: VTODO_FILTER }
  VTODO_FILTER='"filters":[{"comp-filter":{"_attributes":{"name":"VCALENDAR"},"comp-filter":{"_attributes":{"name":"VTODO"}}}}]'
  find "$dir" -path "*/dav-mcp/src/tools/todos/list-todos.js" -exec \
    sed -i 's/{ calendar }/{ calendar, '"$VTODO_FILTER"' }/g' {} \; 2>/dev/null
  find "$dir" -path "*/dav-mcp/src/tools/todos/todo-query.js" -exec \
    sed -i 's/{ calendar }/{ calendar, '"$VTODO_FILTER"' }/g' {} \; 2>/dev/null
done

# Run dav-mcp (npx will use cached version)
exec npx -y dav-mcp "$@"
