#!/bin/bash
# Start a Claude Code master session with ccrelay MCP tools.
# Only THIS session gets the relay tools — other Claude Code sessions are unaffected.
#
# Usage: ./start-master.sh --relay <url> --token <master-token>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MASTER_MCP="$SCRIPT_DIR/packages/master-mcp/dist/index.js"

RELAY_URL=""
TOKEN=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --relay) RELAY_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$TOKEN" ]; then
  echo "Usage: ./start-master.sh --relay <url> --token <master-token>"
  echo ""
  echo "  --relay  Relay WebSocket URL (default: ws://localhost:4080)"
  echo "  --token  Master JWT token (required)"
  exit 1
fi

RELAY_URL="${RELAY_URL:-ws://localhost:4080}"

TMPCONFIG=$(mktemp /tmp/ccrelay-mcp-XXXXXX.json)
node -e "
const config = {
  mcpServers: {
    ccrelay: {
      command: 'node',
      args: ['$MASTER_MCP', '--relay', '$RELAY_URL', '--token', '$TOKEN']
    }
  }
};
require('fs').writeFileSync('$TMPCONFIG', JSON.stringify(config, null, 2));
"

trap "rm -f $TMPCONFIG" EXIT

echo "Starting master session..."
echo "  relay: $RELAY_URL"
echo ""

claude --mcp-config "$TMPCONFIG"
