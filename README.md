# exe.dev for Herdr

One persistent exe.dev VM per committed Git worktree. The laptop supplies the initial Git bundle; editing, Git operations, agents and project commands then run on the VM. Nothing is synchronized back.

This is a standalone, locally tested plugin. It has not been tested against a live VM. It currently requires **Herdr 0.9.0**, Node 22+, Git and OpenSSH on Linux or macOS. Remote bootstrap targets the stock Linux x86_64 exe.dev image. There are no npm dependencies or build steps.

## Install and configure

Install from GitHub:

```sh
herdr plugin install dmnkgrc/herdr-exe-dev-plugin
```

For local development, use `herdr plugin link /absolute/path/to/herdr-exe-dev-plugin --enabled` instead.

Installation exposes actions; it does not allocate a VM. Allocation happens only through an explicit agent-start action. VMs incur charges until deleted; closing a pane, removing a worktree or uninstalling this plugin does not delete them.

Create `config.json` in the directory supplied by Herdr as `HERDR_PLUGIN_CONFIG_DIR`. A first agent-start attempt reports the required path if the file is missing. Replace these fabricated values:

```json
{
  "identityFile": "/Users/example/.ssh/example-exe-dev",
  "sshUser": "exedev",
  "cpu": 2,
  "memory": "4GB",
  "disk": "20GB",
  "argv": ["pi"]
}
```

The selected SSH key must already authorize the intended exe.dev account and work noninteractively without an SSH agent; passphrase prompts are unsupported. Configure SSH host trust separately. The plugin never copies the key, changes account authentication, forwards an SSH agent, or edits `~/.ssh/config`.

Before allocation it creates a private exact-host snippet in `HERDR_PLUGIN_STATE_DIR/routes`. Add an Include for that directory to your own SSH configuration, before broader rules that would override it:

```sshconfig
Include "/absolute/path/to/plugin-state/routes/*.conf"
```

The first missing-Include error reports a concrete snippet path. Retrying an agent start keeps that same allocation intent and alias. `ssh -G` must prove the selected identity, host, user, port and disabled forwarding/multiplexing. Extra identities and proxy routes are refused. Identity paths may contain spaces, but not control characters or SSH substitution tokens.

Provider-reported direct and username-prefixed routes, such as `vm+example@vm.exe.xyz`, are supported. The initial snippet is updated only if it still exactly matches the plugin's provisional contents. After creation, provider identity and routing are frozen; configuration edits apply to new mappings, not existing VMs.

## Repository support

No project configuration is required for an ordinary Git repository. The initial worktree must be clean, attached to a committed branch, and free of initialized submodules or LFS paths. Unpublished commits are included. Local Git configuration, hooks, ignored files, credentials and agent settings are not copied.

The bundle includes reachable Git history, which can contain old secrets. This is a trusted private Git environment, **not a secret-sanitizing uploader**. Set up agent login and Git authentication on the VM itself. A private origin may need remote authentication before push or deletion checks can work.

An optional committed `.herdr/exe.json` supplies remote argv arrays:

```json
{
  "setup": ["npm", "ci"],
  "start": ["npm", "run", "dev"],
  "check": ["npm", "test"],
  "remoteUrl": "https://github.com/example/project.git"
}
```

All fields are optional. `remoteUrl` overrides the source origin and must be a credential-free HTTPS or SSH Git URL. Without either, the VM has no inferred origin. Such a mapping cannot pass guarded deletion's publication check; adding an origin later requires deliberate manual reconciliation, not automatic adoption.

Starting a VM authorizes its committed `setup` command. This is trusted project code, executed remotely after the exact seed is installed. Setup is never run locally. `start` and `check` are separate manual maintenance commands. Submission of a command is not proof of successful completion or application readiness.

## Actions and recovery

The plugin exposes three actions:

- **Start worktree VM:** create and seed the worktree's VM if none exists, run its committed setup, then launch the configured agent in a new remote tab. An existing VM is reused without reseeding. Missing CLIs fail explicitly; no login is copied. Inspect the tab to confirm startup and authentication.
- **Reconnect:** reuse the saved machine and workspace without allocation, reseeding or another agent. This explicit navigation action may enable its saved machine profile and focus the remote workspace.
- **Delete:** open a separate typed-name confirmation pane and run the safeguards below.

List them with `herdr plugin action list --plugin exe-dev`. From the source worktree's Herdr pane, invoke one by its qualified name:

```sh
herdr plugin action invoke exe-dev.start-agent
```

This can allocate a billable VM; it is not an installation check.

### Keyboard shortcuts

Installing the plugin does not change your keys. To bind the three actions, add these entries to your Herdr configuration and run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+alt+e"
type = "plugin_action"
command = "exe-dev.start-agent"
description = "Start worktree VM"

[[keys.command]]
key = "prefix+alt+r"
type = "plugin_action"
command = "exe-dev.reconnect"
description = "Reconnect to worktree VM"

[[keys.command]]
key = "prefix+alt+d"
type = "plugin_action"
command = "exe-dev.delete"
description = "Delete worktree VM"
```

Press and release your prefix, then press Alt+E, Alt+R or Alt+D. With `prefix = "ctrl+a"`, that means Ctrl+A followed by the Alt chord. Delete still requires typed confirmation.

### Manual maintenance

Recovery and inspection are retained outside the three-action menu. Invoke `src/action.mjs` directly as described below, not through `herdr plugin action invoke`:

- `status` reports saved state and authenticated inventory, not application readiness.
- `shell`, `start` and `check` open a fresh remote tab for inspection or a frozen project command.
- `retry-setup` retries frozen setup only after a completed seed and failed setup. A remote lock prevents overlapping attempts.
- `recover` reconciles uncertain creation or deletion and retries owned local cleanup. It never issues another `new` or `rm`; a never-attempted intent needs Start worktree VM.

Mappings use the worktree's Git administrative directory and common directory, not pane IDs. Moving a linked worktree preserves that identity; siblings cannot inherit a removed sibling's VM. For a removed worktree or moved repository, set `HERDR_EXE_DEV_MAPPING` to its saved 64-character mapping ID. This bypasses local-checkout lookup. IDs are reported by Status and are the directory names under `HERDR_PLUGIN_STATE_DIR/mappings`.

For manual recovery outside an action context, invoke `src/action.mjs` with `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_ACTION_ID` and `HERDR_EXE_DEV_MAPPING` set explicitly. Prefer `status` first. Do not erase a mapping to retry allocation.

Corrupt state, missing saved bindings, unknown routes and uncertain seeding are retained rather than recreated or overwritten. An interrupted local process may leave a lock file: verify that the operation and remote setup have stopped before removing that specific stale lock. Deletion leaves a tombstone; archive it deliberately before creating another VM for the same worktree.

Agents share the remote checkout. Concurrent writers need separate remote Git worktrees; tabs alone do not isolate files. Use native Herdr for related splits and keep one owner for shared services and browser work. The release-matched Herdr skill is installed only when absent or identical.

## Deletion safeguards and limits

Confirmation reloads the mapping under its lock and refuses if it changed while the prompt was open. Deletion checks the recorded VM name, creation time, tag and SSH route; all live Herdr panes and their foreground processes; and the actual remote checkout. It refuses dirty/untracked work, stashes, linked worktrees, detached HEAD, unpublished commits or tags, a missing/changed origin, and failed bounded fetches. Liveness and provider identity are checked again after Git inspection.

Stop agents **and all other VM writers/services** before confirming, and keep them stopped until deletion finishes. These are checks, not an atomic write freeze. Processes outside Herdr are not comprehensively inventoried. Git checks do not back up ignored files, databases or other VM data; typed confirmation acknowledges their destruction.

exe.dev deletion is name-only. A concurrent delete/recreate of the same name can race the final identity check. Do not reuse a VM name while an operation is in progress. Only a provider-side conditional delete could remove that remaining race.

An uncertain delete is recorded before the request. Recovery requires authenticated absence of the VM name; malformed inventory, removed tags or a replacement with that name are not absence. Only then are the exact owned SSH snippet and matching machine profile removed. Ambiguous cleanup is retained and reported through `cleanupError` in Status. Recover can retry owned cleanup after proving the VM name is still absent; it never repeats the cloud deletion. There is no force-delete or stale-pane stop action.

## Development

```sh
npm run check
```

Tests run generated scripts against disposable Git repositories and bare origins, exercise action entrypoints through rejecting subprocess fixtures, and use real `ssh -G` with temporary configuration. When Herdr 0.9.0 is installed, an additional test runs its real CLI against a temporary fake Unix socket to verify envelopes and pane-command serialization. No test connects to exe.dev or a live Herdr server.

Deferred: warm bases, shared MCP/OAuth gateways, browser setup, local-agent adapters and automatic provisioning. The action/progress UX was informed by [herdr-sprites-plugin](https://github.com/superfly/herdr-sprites-plugin); VM authority, worktree ownership and credential handling are intentionally different.
