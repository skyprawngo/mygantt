# Development database synchronization (disabled by default)

This optional tool synchronizes a deliberately paired local/server database over
SSH. Starting the MyGantt web server does **not** start or configure synchronization.
A fresh checkout has no enabled peers, addresses, credentials, or database paths.
There is no public synchronization HTTP endpoint or discovery mechanism.

## Configuration

Install `sync.py` into a private directory on each machine. Copy `config.env.example`
to `.env` **beside each installed script** and fill in that machine's values.
The tool reads that exact file, not a `.env` found in the working directory.
Process environment variables with the same names override file values.
Use literal `KEY=value` lines (no shell expansion or quotes). Restrict `.env`
and the installation directory to the service account. Never commit them.
Actual `.env` files must be created or transferred privately on each host;
deployment never provisions or overwrites them.

- `MYGANTT_SYNC_ENABLED`: defaults to disabled; both peers must explicitly set `true`.
- `MYGANTT_SYNC_PAIR_ID`: generate a UUID and provision the same value on both peers.
  It detects pairing mistakes; **SSH authentication is the access control**, not this ID.
- `MYGANTT_SYNC_DB`: absolute path to this machine's database, required on both peers.
  Remote callers cannot choose a different database with a command-line argument.
- `MYGANTT_SYNC_SSH_HOST`: coordinator only; an explicitly configured SSH host/alias.
- `MYGANTT_SYNC_REMOTE_SCRIPT`: coordinator only; installed remote helper's absolute path.
- `MYGANTT_SYNC_DELAY_SECONDS`: coordinator only; minimum 300 seconds.

Use a private SSH key held outside the repository. Verify and register the remote
SSH host key before enabling this tool: unattended calls require a known host key.
Cloning the source does not supply an SSH key or authorize access to another user's server.
This feature does not replace authentication for a separately exposed web server.

## Initial pairing and operation

Stop existing synchronization before setup. Back up both databases and choose
which database supplies the initial contents. Initialization also backs up both
sides, then updates the other side; it must be an intentional operator action:

```sh
python3 /path/to/installed/sync.py initialize --source remote
# Or --source local, if the local database is the intended source.
python3 /path/to/installed/sync.py check
python3 /path/to/installed/sync.py daemon
```

Run a daemon on **one coordinator only**, under the OS service manager of your choice.
`check` validates configuration, peer pairing and schema without changing the DBs.
The helper and watcher on each side enforce enablement and pairing before DB access.
Do not run the daemon in a Git checkout shared with other users.

Initialization refuses to overwrite an existing baseline. A `binding.json` binds
that baseline to the local DB, SSH host, helper path and pair ID. Changing these
requires reviewed re-pairing, not silently reusing the old baseline. Existing
installations upgrading to this version should preserve their baseline and
provision its binding only after verifying the original pair; do not reinitialize
from one side and discard unsynchronized edits.

To disable synchronization, stop the coordinator service (including its watcher
children), set `MYGANTT_SYNC_ENABLED=false` on both sides and leave the service
stopped. Configuration changes require restarting the coordinator/watchers.

## Timing and recovery

Filesystem events start a five-minute batch window; subsequent events do not
restart the countdown. Startup/reconnection also schedules reconciliation.
There is no periodic database copying while idle. Schema differences block sync.
Three-way merging uses projects and templates with their children as conflict
units; conflicting edits are preserved in `conflict.json`, not overwritten.
Writes use SQLite backups, transactions, expected-snapshot validation and foreign
key checks. The baseline advances only after both sides have committed.

Keep `baseline.json`, `binding.json`, `status.json`, `conflict.json`, backups and
`.env` private and outside Git. To resolve a conflict, stop the coordinator, review
both copies and reconcile intentionally before restarting. Retain the baseline.
The web UI may need refreshing after external DB updates.

Tests: `python3 -m unittest discover -s tests -p test_dev_sync.py` from the repository root.
