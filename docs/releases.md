# Releases

The `Checks` workflow installs frozen dependencies, checks formatting/lint/types,
runs unit and container integration tests, scans Git history, and completes the
production-image quickstart restore. Pull requests use read-only permissions.
Actions and external images are pinned to commits or digests.

To release:

1. Update `package.json`'s version in a reviewed commit. The CLI and runtime test
   read that version directly. Keep dependency updates separate.
2. Run the checks and inspect the public changes for secrets and private settings.
3. Push the reviewed `main` commit, then create and push the matching annotated
   `v<version>` tag. Never move a published tag.
4. The release workflow reruns checks, publishes only Linux/amd64 to
   `ghcr.io/benknab/backup-runner:<version>`, then verifies an anonymous pull of the
   exact digest and the image's version, source label, and production-only contents.
5. The final job creates release notes recording the immutable digest and source
   revision. Deploy using `tag@sha256:digest`.

Only the publish job receives package-write permission. Existing version images
are not overwritten. If publication succeeds but verification fails, fix the
verification prerequisite and rerun **only failed jobs**; rebuilding an existing
version is intentionally rejected. Use a new version for code fixes.

GHCR package visibility is separate from repository visibility. On the first
release, an administrator may need to make the linked container package public
in GitHub's package settings before anonymous verification succeeds. A release is
not complete until that verification and the final release job pass.

The credential-free suite covers real SQLite, PostgreSQL, Restic, Git/LFS, GPG,
and archive tools. It simulates Proton responses. An account-backed Proton smoke
test is performed separately with a dedicated test job/folder and state volume;
see [restores](restores.md). No production account or secret is attached to CI.
