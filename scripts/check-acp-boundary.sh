#!/usr/bin/env bash
set -euo pipefail

# This is a secondary inventory guard. The Rust module boundary is the
# authority: raw Supervisor transport methods are private. This scan catches
# accidental reintroduction of a server/plugin bypass and keeps the explicit
# external CLI maintenance exception visible in CI.

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
server_root="$repo_root/src/server"
plugin_root="$repo_root/src/plugin"

raw_methods='wait_until_ready|send_prompt|reset_session_context|cancel_prompt|force_end_turn|set_mode|set_config_option|resolve_permission|resolve_elicitation|publish_user_prompt_with_attachments|publish_user_diff_comments_prompt'
unrouted_method='cancel_permission'

if [[ "${1:-}" == "--self-test" ]]; then
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  mkdir -p "$fixture/src/server"
  printf '%s\n' 'async fn synthetic(state: AppState) { state.acp_supervisor.send_prompt("s", "x", &[]).await; }' \
    >"$fixture/src/server/bypass.rs"
  if rg -n -U --glob '*.rs' \
    "\\.acp_supervisor[[:space:]]*\\.[[:space:]]*($raw_methods)[[:space:]]*\\(" \
    "$fixture/src/server" >/dev/null; then
    echo "ACP boundary self-test caught the synthetic bypass."
  else
    echo "ACP boundary self-test failed to catch the synthetic bypass." >&2
    exit 1
  fi
  exit 0
fi

unexpected=$(rg -n -U --glob '*.rs' \
  "\\.acp_supervisor[[:space:]]*\\.[[:space:]]*($raw_methods)[[:space:]]*\\(" \
  "$server_root" "$plugin_root" || true)
if [[ -n "$unexpected" ]]; then
  echo "ACP control-plane bypass detected in server/plugin code:" >&2
  echo "$unexpected" >&2
  exit 1
fi

direct_store_mutation=$(rg -n --glob '*.rs' \
  'acp_event_store[[:space:]]*\.[[:space:]]*(delete_session|hard_delete_session|record|record_at|record_attachment|delete_attachments_for_seq)[[:space:]]*\(' \
  "$server_root" "$plugin_root" || true)
if [[ -n "$direct_store_mutation" ]]; then
  echo "Direct ACP event-store mutation outside the control plane:" >&2
  echo "$direct_store_mutation" >&2
  exit 1
fi

if ! rg -n 'purge_acp_transcript_rows|acp_event_topics' "$repo_root/src/cli/mod.rs" >/dev/null; then
  echo "The explicit non-serve ACP hard-purge maintenance writer is missing its topic cleanup." >&2
  exit 1
fi

if rg -n --glob '*.rs' \
  "pub[[:space:]]+async[[:space:]]+fn[[:space:]]+($raw_methods)[[:space:]]*\\(" \
  "$repo_root/src/acp/supervisor.rs" >/dev/null; then
  echo "Raw ACP transport methods must remain private to supervisor.rs; use AcpControlPlane." >&2
  exit 1
fi

if ! rg -n "pub[[:space:]]+async[[:space:]]+fn[[:space:]]+$unrouted_method[[:space:]]*\\(" \
  "$repo_root/src/acp/acp_client.rs" >/dev/null; then
  echo "The intentionally unrouted AcpClient::cancel_permission method disappeared from the inventory." >&2
  exit 1
fi

echo "ACP raw transport inventory (low-level boundary and explicit maintenance exception):"
rg -n --glob '*.rs' \
  "($raw_methods)[[:space:]]*\\(" \
  "$repo_root/src/acp/supervisor.rs" "$repo_root/src/acp/acp_client.rs" \
  "$repo_root/src/acp/client" "$repo_root/src/cli/mod.rs" || true
echo "Intentionally unrouted low-level method:"
rg -n "$unrouted_method[[:space:]]*\\(" "$repo_root/src/acp/acp_client.rs" || true
echo "ACP boundary inventory passed."
