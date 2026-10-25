# Ankh

Backs up SQLite and PostgreSQL databases and Git repositories hosted on Gitea,
including Git LFS objects. Keeps encrypted local snapshots with Restic and uploads
compressed archives with SHA-256 checksums to Proton Drive.

Supports unattended scheduled runs, configurable retention, and a persistent
upload queue. Failed uploads stay on disk for retry, and a failed destination
doesn't prevent backups to the other destinations.

[Quickstart](docs/quickstart.md) · [Configuration](docs/configuration.md) ·
[Operations](docs/operations.md) · [Restores](docs/restores.md) ·
[Architecture](docs/architecture.md)
