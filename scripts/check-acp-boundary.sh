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
runner_raw_methods='agent_request|agent_prompt|agent_cancel|run_or_replay_initialize|run_or_replay_session|intercept_handshake|note_relay_session_new|refresh_session_cache_from_relay|handle_connection|handle_control_connection|cancel_outstanding_requests|write_control_frame'
lifecycle_paths='reconcile_acp_workers|trigger_resume_background|spawn_inner|shutdown_and_delete|publish_stopped_if_seq|cancel_orphaned_approvals|cancel_orphaned_elicitations'

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

  cat >"$fixture/lib.rs" <<'EOF'
mod acp {
    pub mod supervisor {
        pub struct Supervisor;
        impl Supervisor {
            fn send_prompt(&self) {}
        }
    }
}

mod server {
    fn compile_negative_boundary(supervisor: &super::acp::supervisor::Supervisor) {
        supervisor.send_prompt();
    }
}
EOF
  mkdir -p "$fixture/out"
  if rustc --edition=2021 --crate-type lib "$fixture/lib.rs" \
    --out-dir "$fixture/out" 2>"$fixture/compile-negative.stderr"; then
    echo "ACP boundary compile-negative fixture unexpectedly compiled." >&2
    exit 1
  fi
  echo "ACP boundary compile-negative fixture rejected the raw method."
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

for method in ${runner_raw_methods//|/ }; do
  if ! rg -n --glob '*.rs' "${method}[[:space:]]*\\(" \
    "$repo_root/src/process/runner.rs" >/dev/null; then
    echo "Runner raw method disappeared from the inventory: ${method}" >&2
    exit 1
  fi
done

for path in ${lifecycle_paths//|/ }; do
  if ! rg -n --glob '*.rs' "${path}[[:space:]]*\\(" \
    "$repo_root/src/acp/supervisor.rs" "$repo_root/src/server" >/dev/null; then
    echo "ACP lifecycle/reconciler path disappeared from the inventory: ${path}" >&2
    exit 1
  fi
done

echo "ACP raw transport inventory (low-level boundary and explicit maintenance exception):"
rg -n --glob '*.rs' \
  "($raw_methods)[[:space:]]*\\(" \
  "$repo_root/src/acp/supervisor.rs" "$repo_root/src/acp/acp_client.rs" \
  "$repo_root/src/acp/client" "$repo_root/src/cli/mod.rs" || true
echo "Intentionally unrouted low-level method:"
rg -n "$unrouted_method[[:space:]]*\\(" "$repo_root/src/acp/acp_client.rs" || true
echo "Runner raw relay/lifecycle inventory:"
rg -n --glob '*.rs' "($runner_raw_methods)[[:space:]]*\\(" \
  "$repo_root/src/process/runner.rs" || true
echo "Supervisor/server lifecycle inventory:"
rg -n --glob '*.rs' "($lifecycle_paths)[[:space:]]*\\(" \
  "$repo_root/src/acp/supervisor.rs" "$repo_root/src/server" || true
echo "ACP boundary inventory passed."
