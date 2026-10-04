# Ubuntu deployment

The delivery design uses GitHub-hosted Actions CI and an unprivileged host timer. The timer checks the public repository's current main once daily at 03:00 Asia/Seoul. There is no boot or periodic polling trigger. Persistent=false skips a run missed while the host is off; it waits until the next 03:00 rather than catching up on startup. It accepts only a completed successful run of this repository's CI workflow for that exact SHA, triggered by a main push or a manual dispatch on main. It fetches that SHA, runs the unit/API tests and syntax checks locally, then switches a release symlink. PR-triggered runs, other branches, other repositories, failed/pending CI, links/special files and database/credential files in the archive are rejected. No production runner, PAT, SSH ingress or deployment credential is used.

An installed root-owned supervisor runs as the configured unprivileged service user. It watches the release symlink, stops its own child app, makes an integrity-checked SQLite backup before startup/migration, starts new code and checks the loopback API. If startup/health fails it starts the previous code with the existing database. The fetcher restores the previous current symlink after failure. SQLite changes are not automatically undone; keep the verified backup for operator recovery. An already failed SHA is not retried automatically. Repair it locally or push a new tested main commit. Old releases and backups are retained; cleanup is an operator decision.

## Review before installing

Confirm the existing service user, source location, Python/Node paths and free loopback port. Examples use /srv/mygantt for release/cache delivery, /var/lib/mygantt/mygantt.sqlite3 for persistent data, /var/lib/mygantt/backups for backups, /var/lib/mygantt-delivery/status.json for non-secret deployment status, and /var/lib/mygantt-socket/http.sock for the private origin socket. Data stays outside replaceable releases. Production always runs with --no-seed: no example templates or batches are inserted, and existing records are preserved.

Install delivery.py, supervisor.py, poll-deploy.py and request-deploy.py as reviewed root-owned files under /usr/local/libexec/mygantt/. The timer never replaces these installed host-control files from a repository push. Updating that control layer requires separate administrator review/install. These programs refuse UID 0 and never invoke sudo or systemctl for deployment. Only a startup permission probe invokes sudo -n true; it must be blocked by the service sandbox or the service refuses to start.

Render the service examples with @SERVICE_USER@ replaced by the approved existing account. Install the app service, deploy service, manual-request path unit and timer under /etc/systemd/system/ only after review. The app reads releases through a read-only mount and writes only its data/socket/status directories. The fetcher writes the release root and cannot access data or socket directories. Both units hide home/run-user directories, /proc and administrative sockets, remove capabilities and prevent privilege escalation. Startup probes check effective permissions. This is process isolation under an existing identity; it does not isolate MyGantt from administrators or other processes deliberately run outside these units under that same host account.

Create only approved directories and set release delivery ownership to the service user. Root ownership is required for installed control scripts, units, nginx configuration and origin compose file. Administrator privilege is used for initial installation and normal Docker/systemd management, never granted to the deployer. Enable/start the supervisor, run the deploy service once and check its exact SHA/status before enabling the timer. An empty production DB is expected on first install; do not copy a development database unless migration was explicitly requested.

## Private Docker tunnel origin

The app binds TCP only to 127.0.0.1:8765 and also serves the API/UI over its Unix socket. Socket mode is 0600 and parent mode is 0700. The nginx example runs at the same numeric UID/GID as the host service, with all capabilities dropped, no-new-privileges, read-only filesystem and only socket/config mounts. Port 8080 is internal to Docker; there is no host port mapping. The persistent socket parent avoids stale bind mounts across restarts/reboot.

Create an approved internal network named mygantt_tunnel, add only the origin and the chosen existing cloudflared connector, and preserve the connector's existing networks/routes. Record the extra external network in its existing compose configuration so recreation preserves it. Review a compose metadata comparison before changing existing configuration. The nginx image is pinned to a verified official image digest; refresh only after review. Set MYGANTT_UID and MYGANTT_GID to the service account's actual numeric IDs before creating the origin.

Configure Cloudflare Access for the entire hostname with the approved exact email allowlist and default deny, without bypass or service-token policies. Confirm the application and identity provider before adding hostname route/DNS. After Access protects the hostname, route it to http://mygantt-origin:8080 through the chosen existing tunnel. Do not publish the unauthenticated app while Access is unfinished. Public unauthenticated requests must reach the login gate; an approved logged-in user must be able to use the app. Loopback remains available to the host. The internal origin trusts its private tunnel network.

## Validation and limits

Verify app/deployer UID, effective startup permission probes, loopback/socket serving, empty initial state, backup integrity and rollback tests, current commit's successful GitHub run, one completed local delivery, timer state, no new public/LAN listener and existing app/tunnel health. GitHub anonymous API rate limits or network failures postpone delivery and preserve the current release. A successful push waits for the next daily check unless the local manual command is used. Successful CI or a started local server alone does not establish public deployment completion.

The older activate-release.sh remains an optional manual administrative helper. Automation does not execute it or any repository script as root.

## Manual deployment and edit visibility

Install the reviewed request-deploy.py executable and a root-owned /usr/local/bin/mygantt-deploy symlink to it. Enable mygantt-deploy.path. As the existing service user, run:

```sh
mygantt-deploy --wait
```

This command only writes a local request marker. The systemd path unit starts the same User=service-user restricted deploy service used by the daily timer. CI-success/current-main checks, local tests, backups, health checks and code rollback stay the same. No sudo or deployment credential is needed. The matching result distinguishes deployed, unchanged, waiting_for_ci, superseded and failure. A CI run started with GitHub workflow_dispatch does not itself wake this host: after CI finishes, run the local command or wait for the next 03:00.

The provided Python server does not have automatic browser or Python reload. It reads HTML/JS/CSS files on each HTTP request, so frontend edits in a directly served local checkout require a browser refresh. Python imports are loaded at process startup and require a server restart. A 192.168.x.x URL alone does not prove which machine/checkout is serving it or that live reload is enabled. Ubuntu production serves the deployed commit directory, so local Mac source changes require a push, successful main CI and the daily/manual deployment before they appear there.
