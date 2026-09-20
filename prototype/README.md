# Backup runner

This one-shot image creates and verifies an application-owned snapshot, then sends that same snapshot to every destination listed in the job. It does not scan the host, control other containers, or mount the Docker socket. Each application opts in through its own Compose `backup` profile and job file.

Supported sources:

- `sqlite`: use SQLite's online backup API, then run `PRAGMA quick_check` on the staged copy.
- `gitea-git`: mirror every repository visible to the backup token, fetch all Git LFS objects, then run `git fsck --full`.

Supported destinations:

- `restic`: write an encrypted incremental snapshot to the external drive, then apply the job's retention policy.
- `proton-drive`: create a checked `tar.zst` archive and SHA-256 file, queue both on the external drive, then upload them through Proton's official end-to-end encrypted CLI.

The runner checks the external drive's serial and filesystem UUID through `.backup-drive-sentinel` before every operation. Destinations run independently. A Restic failure does not block the Proton attempt, and a Proton failure does not remove a successful Restic snapshot. The job still exits with a failure if either destination fails.

## Host setup

Create one random Restic password and save another copy in the password manager:

```sh
sudo install -d -o root -g root -m 700 /etc/backup-runner
openssl rand -base64 48 | sudo tee /etc/backup-runner/restic-password >/dev/null
sudo chmod 600 /etc/backup-runner/restic-password
```

The image pins Proton Drive CLI 0.8.0 and checks its binary against Proton's published SHA-512 value during the build. Sign in once from `server/backup-runner/`:

```sh
docker volume create backup-proton-state
docker compose run --rm proton-auth
```

Open the printed URL on any device and keep the command running until login finishes. The external Docker volume `backup-proton-state` retains the CLI state and cannot be removed by an application stack's `docker compose down -v`. The supported `pass` credential store encrypts the session with a dedicated local GPG key; the runner never receives the Proton password.

Initialize the repository through one configured application stack:

```sh
docker compose --profile backup run --rm backup init
```

Run and check a job:

```sh
docker compose --profile backup run --rm backup backup
docker compose --profile backup run --rm backup check
docker compose --profile backup run --rm backup check-read-data
```

Use `check` for the monthly metadata check. It checks Restic metadata, the Proton folder, remote archive pairs, and every queued archive pair. `check-read-data` also reads every Restic pack and suits a quarterly check. It does not download every Proton archive.

## Retention

Each successful job keeps 14 daily, 8 weekly, 12 monthly, and 5 yearly copies at both destinations. Restic applies the policy to snapshots carrying that job's tag, then prunes unneeded repository data. Proton applies the policy in UTC to timestamped archive pairs and moves expired pairs to Proton's trash. It does not empty the account's trash.

Failed Proton uploads stay under `/mnt/backup-drive/outbox/<job>/` and every later run checks and retries all complete queued archives. The runner removes a local outbox pair only after Proton confirms that both the archive and its checksum file exist remotely. A missing or bad checksum blocks upload and reports a failed job.

## Limits

The Gitea source protects Git history and LFS objects, not Gitea users, issues, settings, or its SQLite database. Do not treat it as a full Gitea instance backup.

Proton Drive restore tests must download both files, verify the SHA-256 value, test the Zstandard stream, and extract the archive into an empty directory. Do not restore over live application data.

## Schedule

`run-all.sh` invokes only the application stacks listed in that file. Install the included systemd service and timer after every listed job passes by hand:

```sh
sudo install -o root -g root -m 644 systemd/backup-runner.service /etc/systemd/system/
sudo install -o root -g root -m 644 systemd/backup-runner.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now backup-runner.timer
systemctl list-timers backup-runner.timer
```

The timer runs daily at 03:30 UTC. The host wrapper uses a lock and runs each opted-in Compose job in order. A failed job does not prevent the remaining jobs from running, but the systemd service exits with a failure so the journal records the problem.
