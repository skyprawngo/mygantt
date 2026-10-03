# Ubuntu deployment handoff

This folder prepares a host-side systemd setup without assuming the Ubuntu host's account, directories, tunnel ingress, or delivery method. Nothing here is run by GitHub Actions. The activation helper does not fetch or upload source, touch the SQLite database, change Cloudflare settings, or create credentials.

## Host setup

Choose the service account, release directory, stable data directory, Python path, and port only after confirming the target's existing layout. Use absolute paths without spaces unless you escape them for systemd. Keep the data directory outside every release directory. The service example binds only to `127.0.0.1`; do not expose the app port on a public interface.

Copy a database-free release to a unique path such as `<release-root>/<commit-sha>`. Before the first launch against any existing SQLite database, stop its current writer and take a verified backup. The app can apply schema migrations at startup; release rollback does not roll back database changes.

Copy `mygantt.service.example.in` to the host and replace every `@...@` token with the confirmed service user, current-release symlink, Python executable, port, and persistent data directory. Review the rendered unit before installing it under `/etc/systemd/system/`. Give the service account read-only access to the release and write access only to the persistent data directory. Then reload systemd and start the service as a separately reviewed host action.

Check that the existing Cloudflare Tunnel ingress points to `http://127.0.0.1:<confirmed-port>` and that its Access policy still limits sign-in to the intended allowlist. This project does not modify tunnel or Access settings. Never expose the app's port directly to the Internet.

## Activate a prepared release

Run the helper on the Ubuntu host after the release directory and systemd unit have been reviewed and installed:

```sh
sudo deploy/ubuntu/activate-release.sh \
  /absolute/path/to/current \
  /absolute/path/to/releases/COMMIT_SHA \
  mygantt.service \
  http://127.0.0.1:8765/api/state
```

It validates the release contents and refuses SQLite files under the release. It atomically changes the `current` symlink, restarts the named service, and checks the local API. If restart or health check fails, it restores the previous symlink when available and requests a service restart. It does not delete old releases or modify database contents. Keep backups and release retention under an explicit operator policy.

## GitHub workflow boundary

The current workflow tests untrusted pull-request code only on GitHub-hosted workers. Do not add a self-hosted deployment runner or production credentials until the supported remote execution route and account/service ownership are confirmed. A future deploy job should accept only trusted `main` pushes and manual dispatch; it must never execute pull-request code on the host. Repository protection and deployment approval policy remain to be configured after publication.
