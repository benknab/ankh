import { Result, type UnhandledException } from "better-result";

type AppError = Error | UnhandledException;
type AppResult<T> = Result<T, AppError>;

type Retention = {
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
};

type ResticDestination = {
  type: "restic";
  repository: string;
  passwordFile: string;
};

type ProtonDriveDestination = {
  type: "proton-drive";
  remoteFolder: string;
  outbox: string;
};

type Destination = ResticDestination | ProtonDriveDestination;

type BackupDrive = {
  sentinelFile: string;
  driveSerial: string;
  filesystemUuid: string;
};

type SqliteSource = {
  type: "sqlite";
  path: string;
  output: string;
};

type GiteaGitSource = {
  type: "gitea-git";
  apiUrl: string;
  tokenFile: string;
};

type Source = SqliteSource | GiteaGitSource;

type Job = {
  version: 1;
  name: string;
  host: string;
  source: Source;
  backupDrive: BackupDrive;
  destinations: Destination[];
  retention: Retention;
};

type GiteaRepository = {
  full_name: string;
};

export type ProtonSnapshot = {
  archiveName: string;
  createdAt: Date;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): AppResult<string> {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return Result.err(new Error(`Expected a non-empty string at '${key}'`));
  }
  return Result.ok(value);
}

function requiredCount(
  record: Record<string, unknown>,
  key: string,
): AppResult<number> {
  const value = record[key];
  if (!Number.isInteger(value) || Number(value) < 0) {
    return Result.err(new Error(`Expected a non-negative integer at '${key}'`));
  }
  return Result.ok(Number(value));
}

function parseSource(value: unknown): AppResult<Source> {
  const source = asRecord(value);
  if (!source) {
    return Result.err(new Error("Expected 'source' to be an object"));
  }
  const type = requiredString(source, "type");
  if (type.isErr()) {
    return type;
  }

  if (type.value === "sqlite") {
    const path = requiredString(source, "path");
    if (path.isErr()) {
      return path;
    }
    const output = requiredString(source, "output");
    if (output.isErr()) {
      return output;
    }
    if (
      output.value.includes("/") || output.value === "." ||
      output.value === ".."
    ) {
      return Result.err(new Error("SQLite 'output' must be a file name"));
    }
    return Result.ok({
      type: "sqlite",
      path: path.value,
      output: output.value,
    });
  }

  if (type.value === "gitea-git") {
    const apiUrl = requiredString(source, "apiUrl");
    if (apiUrl.isErr()) {
      return apiUrl;
    }
    const tokenFile = requiredString(source, "tokenFile");
    if (tokenFile.isErr()) {
      return tokenFile;
    }
    return Result.ok({
      type: "gitea-git",
      apiUrl: apiUrl.value,
      tokenFile: tokenFile.value,
    });
  }

  return Result.err(new Error(`Unsupported source type: ${type.value}`));
}

function parseBackupDrive(value: unknown): AppResult<BackupDrive> {
  const drive = asRecord(value);
  if (!drive) {
    return Result.err(new Error("Expected 'backupDrive' to be an object"));
  }
  const sentinelFile = requiredString(drive, "sentinelFile");
  if (sentinelFile.isErr()) {
    return sentinelFile;
  }
  const driveSerial = requiredString(drive, "driveSerial");
  if (driveSerial.isErr()) {
    return driveSerial;
  }
  const filesystemUuid = requiredString(drive, "filesystemUuid");
  if (filesystemUuid.isErr()) {
    return filesystemUuid;
  }
  return Result.ok({
    sentinelFile: sentinelFile.value,
    driveSerial: driveSerial.value,
    filesystemUuid: filesystemUuid.value,
  });
}

function parseDestination(value: unknown): AppResult<Destination> {
  const destination = asRecord(value);
  if (!destination) {
    return Result.err(new Error("Expected each destination to be an object"));
  }
  const type = requiredString(destination, "type");
  if (type.isErr()) {
    return type;
  }

  if (type.value === "restic") {
    const repository = requiredString(destination, "repository");
    if (repository.isErr()) {
      return repository;
    }
    const passwordFile = requiredString(destination, "passwordFile");
    if (passwordFile.isErr()) {
      return passwordFile;
    }
    return Result.ok({
      type: "restic",
      repository: repository.value,
      passwordFile: passwordFile.value,
    });
  }

  if (type.value === "proton-drive") {
    const remoteFolder = requiredString(destination, "remoteFolder");
    if (remoteFolder.isErr()) {
      return remoteFolder;
    }
    if (!remoteFolder.value.startsWith("/my-files/")) {
      return Result.err(
        new Error("Proton Drive 'remoteFolder' must start with '/my-files/'"),
      );
    }
    const outbox = requiredString(destination, "outbox");
    if (outbox.isErr()) {
      return outbox;
    }
    return Result.ok({
      type: "proton-drive",
      remoteFolder: remoteFolder.value.replace(/\/$/, ""),
      outbox: outbox.value.replace(/\/$/, ""),
    });
  }

  return Result.err(new Error(`Unsupported destination type: ${type.value}`));
}

function parseRetention(value: unknown): AppResult<Retention> {
  const retention = asRecord(value);
  if (!retention) {
    return Result.err(new Error("Expected 'retention' to be an object"));
  }
  const daily = requiredCount(retention, "daily");
  if (daily.isErr()) {
    return daily;
  }
  const weekly = requiredCount(retention, "weekly");
  if (weekly.isErr()) {
    return weekly;
  }
  const monthly = requiredCount(retention, "monthly");
  if (monthly.isErr()) {
    return monthly;
  }
  const yearly = requiredCount(retention, "yearly");
  if (yearly.isErr()) {
    return yearly;
  }
  return Result.ok({
    daily: daily.value,
    weekly: weekly.value,
    monthly: monthly.value,
    yearly: yearly.value,
  });
}

export function parseJob(value: unknown): AppResult<Job> {
  const job = asRecord(value);
  if (!job) {
    return Result.err(new Error("Expected the job file to contain an object"));
  }
  if (job.version !== 1) {
    return Result.err(new Error("Expected job version 1"));
  }
  const name = requiredString(job, "name");
  if (name.isErr()) {
    return name;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name.value)) {
    return Result.err(
      new Error(
        "Job name may contain only lowercase letters, numbers, and hyphens",
      ),
    );
  }
  const host = requiredString(job, "host");
  if (host.isErr()) {
    return host;
  }
  const source = parseSource(job.source);
  if (source.isErr()) {
    return source;
  }
  const backupDrive = parseBackupDrive(job.backupDrive);
  if (backupDrive.isErr()) {
    return backupDrive;
  }
  if (!Array.isArray(job.destinations) || job.destinations.length === 0) {
    return Result.err(new Error("Expected at least one destination"));
  }
  const destinations: Destination[] = [];
  for (const value of job.destinations) {
    const destination = parseDestination(value);
    if (destination.isErr()) {
      return destination;
    }
    destinations.push(destination.value);
  }
  if (
    new Set(destinations.map((destination) => destination.type)).size !==
      destinations.length
  ) {
    return Result.err(
      new Error("A job may configure each destination type once"),
    );
  }
  const retention = parseRetention(job.retention);
  if (retention.isErr()) {
    return retention;
  }
  return Result.ok({
    version: 1,
    name: name.value,
    host: host.value,
    source: source.value,
    backupDrive: backupDrive.value,
    destinations,
    retention: retention.value,
  });
}

async function readTextFile(path: string): Promise<AppResult<string>> {
  return await Result.tryPromise(() => Deno.readTextFile(path));
}

async function loadJob(path: string): Promise<AppResult<Job>> {
  const text = await readTextFile(path);
  if (text.isErr()) {
    return text;
  }
  const parsed = Result.try(() => JSON.parse(text.value) as unknown);
  if (parsed.isErr()) {
    return parsed;
  }
  return parseJob(parsed.value);
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<AppResult<string>> {
  const commandOptions: Deno.CommandOptions = {
    args,
    stdout: "piped",
    stderr: "piped",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const output = await Result.tryPromise(() =>
    new Deno.Command(command, commandOptions).output()
  );
  if (output.isErr()) {
    return output;
  }
  if (!output.value.success) {
    const stderr = decoder.decode(output.value.stderr).trim();
    return Result.err(
      new Error(`${command} failed with code ${output.value.code}: ${stderr}`),
    );
  }
  return Result.ok(decoder.decode(output.value.stdout).trim());
}

async function ensureDirectory(path: string): Promise<AppResult<void>> {
  const result = await Result.tryPromise(() =>
    Deno.mkdir(path, { recursive: true })
  );
  if (result.isErr()) {
    return result;
  }
  return Result.ok();
}

async function removeIfPresent(path: string): Promise<AppResult<void>> {
  const result = await Result.tryPromise(async () => {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return Promise.reject(error);
      }
    }
  });
  if (result.isErr()) {
    return result;
  }
  return Result.ok();
}

export function parseSentinel(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

async function checkBackupDrive(job: Job): Promise<AppResult<void>> {
  const sentinelText = await readTextFile(job.backupDrive.sentinelFile);
  if (sentinelText.isErr()) {
    return Result.err(
      new Error(
        `Backup drive sentinel is unavailable at ${job.backupDrive.sentinelFile}`,
      ),
    );
  }
  const sentinel = parseSentinel(sentinelText.value);
  if (sentinel.get("serial") !== job.backupDrive.driveSerial) {
    return Result.err(new Error("Backup drive serial does not match the job"));
  }
  if (sentinel.get("uuid") !== job.backupDrive.filesystemUuid) {
    return Result.err(
      new Error("Backup filesystem UUID does not match the job"),
    );
  }
  return Result.ok();
}

async function checkResticDestination(
  destination: ResticDestination,
): Promise<AppResult<void>> {
  const password = await readTextFile(destination.passwordFile);
  if (password.isErr() || password.value.trim().length === 0) {
    return Result.err(new Error("Restic password file is missing or empty"));
  }
  return Result.ok();
}

function resticEnvironment(
  destination: ResticDestination,
): Record<string, string> {
  return {
    RESTIC_CACHE_DIR: "/tmp/restic-cache",
    RESTIC_REPOSITORY: destination.repository,
    RESTIC_PASSWORD_FILE: destination.passwordFile,
  };
}

function protonDriveEnvironment(): Record<string, string> {
  return {
    GNUPGHOME: "/proton/gnupg",
    HOME: "/tmp",
    PASSWORD_STORE_DIR: "/proton/pass",
    PROTON_DRIVE_CACHE_DIR: "/proton/cache",
    PROTON_DRIVE_CREDENTIALS_STORE: "pass",
    PROTON_DRIVE_LOG_LEVEL: "WARNING",
  };
}

async function stageSqlite(
  job: Job,
  source: SqliteSource,
): Promise<AppResult<string>> {
  const stageDirectory = `/staging/${job.name}`;
  const removed = await removeIfPresent(stageDirectory);
  if (removed.isErr()) {
    return removed;
  }
  const created = await ensureDirectory(stageDirectory);
  if (created.isErr()) {
    return created;
  }
  const outputPath = `${stageDirectory}/${source.output}`;
  const backup = await runCommand("sqlite3", [
    `file:${source.path}?mode=ro`,
    `.timeout 60000`,
    `.backup ${outputPath}`,
  ]);
  if (backup.isErr()) {
    return backup;
  }
  const check = await runCommand("sqlite3", [
    outputPath,
    "PRAGMA quick_check;",
  ]);
  if (check.isErr()) {
    return check;
  }
  if (check.value !== "ok") {
    return Result.err(new Error(`SQLite verification failed: ${check.value}`));
  }
  return Result.ok(stageDirectory);
}

async function listGiteaRepositories(
  source: GiteaGitSource,
  token: string,
): Promise<AppResult<GiteaRepository[]>> {
  const repositories: GiteaRepository[] = [];
  for (let page = 1;; page++) {
    const url = new URL(
      "api/v1/user/repos",
      source.apiUrl.endsWith("/") ? source.apiUrl : `${source.apiUrl}/`,
    );
    url.searchParams.set("limit", "50");
    url.searchParams.set("page", String(page));
    const response = await Result.tryPromise(() =>
      fetch(url, { headers: { Authorization: `token ${token}` } })
    );
    if (response.isErr()) {
      return response;
    }
    if (!response.value.ok) {
      return Result.err(
        new Error(`Gitea API returned HTTP ${response.value.status}`),
      );
    }
    const body = await Result.tryPromise(() =>
      response.value.json() as Promise<unknown>
    );
    if (body.isErr()) {
      return body;
    }
    if (!Array.isArray(body.value)) {
      return Result.err(
        new Error("Gitea repository response was not an array"),
      );
    }
    for (const item of body.value) {
      const record = asRecord(item);
      if (!record || typeof record.full_name !== "string") {
        return Result.err(
          new Error("Gitea returned an invalid repository record"),
        );
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.full_name)) {
        return Result.err(
          new Error(`Unsafe Gitea repository name: ${record.full_name}`),
        );
      }
      repositories.push({ full_name: record.full_name });
    }
    if (body.value.length < 50) {
      break;
    }
  }
  return Result.ok(repositories);
}

async function stageGiteaGit(
  job: Job,
  source: GiteaGitSource,
): Promise<AppResult<string>> {
  const tokenText = await readTextFile(source.tokenFile);
  if (tokenText.isErr() || tokenText.value.trim().length === 0) {
    return Result.err(new Error("Gitea backup token file is missing or empty"));
  }
  const token = tokenText.value.trim();
  const repositories = await listGiteaRepositories(source, token);
  if (repositories.isErr()) {
    return repositories;
  }

  const stageDirectory = `/staging/${job.name}`;
  const mirrorsDirectory = `${stageDirectory}/repositories`;
  const created = await ensureDirectory(mirrorsDirectory);
  if (created.isErr()) {
    return created;
  }
  const authArgs = ["-c", `http.extraHeader=Authorization: token ${token}`];

  for (const repository of repositories.value) {
    const mirrorPath = `${mirrorsDirectory}/${repository.full_name}.git`;
    const parent = mirrorPath.slice(0, mirrorPath.lastIndexOf("/"));
    const parentResult = await ensureDirectory(parent);
    if (parentResult.isErr()) {
      return parentResult;
    }
    let exists = true;
    const stat = await Result.tryPromise(() => Deno.stat(mirrorPath));
    if (stat.isErr()) {
      if (stat.error instanceof Deno.errors.NotFound) {
        exists = false;
      } else {
        return stat;
      }
    }

    const sync = exists
      ? await runCommand("git", [
        ...authArgs,
        "-C",
        mirrorPath,
        "remote",
        "update",
        "--prune",
      ])
      : await runCommand("git", [
        ...authArgs,
        "clone",
        "--mirror",
        new URL(
          `${repository.full_name}.git`,
          source.apiUrl.endsWith("/") ? source.apiUrl : `${source.apiUrl}/`,
        ).toString(),
        mirrorPath,
      ]);
    if (sync.isErr()) {
      return sync;
    }

    const lfs = await runCommand("git", [
      ...authArgs,
      "-C",
      mirrorPath,
      "lfs",
      "fetch",
      "--all",
      "origin",
    ]);
    if (lfs.isErr()) {
      return lfs;
    }
    const verify = await runCommand("git", [
      "-C",
      mirrorPath,
      "fsck",
      "--full",
    ]);
    if (verify.isErr()) {
      return verify;
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    repositories: repositories.value.map((repository) => repository.full_name)
      .sort(),
  };
  const written = await Result.tryPromise(() =>
    Deno.writeFile(
      `${stageDirectory}/manifest.json`,
      encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    )
  );
  if (written.isErr()) {
    return written;
  }
  return Result.ok(stageDirectory);
}

async function stageSource(job: Job): Promise<AppResult<string>> {
  switch (job.source.type) {
    case "sqlite":
      return await stageSqlite(job, job.source);
    case "gitea-git":
      return await stageGiteaGit(job, job.source);
  }
}

async function initializeRestic(
  destination: ResticDestination,
): Promise<AppResult<void>> {
  const checked = await checkResticDestination(destination);
  if (checked.isErr()) {
    return checked;
  }
  const config = await Result.tryPromise(() =>
    Deno.stat(`${destination.repository}/config`)
  );
  if (config.isOk()) {
    console.log(
      `Restic repository already exists at ${destination.repository}`,
    );
    return Result.ok();
  }
  if (!(config.error instanceof Deno.errors.NotFound)) {
    return config;
  }
  const initialized = await runCommand("restic", ["init"], {
    env: resticEnvironment(destination),
  });
  if (initialized.isErr()) {
    return initialized;
  }
  console.log(initialized.value);
  return Result.ok();
}

async function backupRestic(
  job: Job,
  stageDirectory: string,
  destination: ResticDestination,
): Promise<AppResult<void>> {
  const checked = await checkResticDestination(destination);
  if (checked.isErr()) {
    return checked;
  }
  const tag = `job:${job.name}`;
  const snapshot = await runCommand("restic", [
    "backup",
    stageDirectory,
    "--host",
    job.host,
    "--tag",
    tag,
  ], { env: resticEnvironment(destination) });
  if (snapshot.isErr()) {
    return snapshot;
  }
  console.log(snapshot.value);

  const retention = job.retention;
  const forgotten = await runCommand("restic", [
    "forget",
    "--host",
    job.host,
    "--tag",
    tag,
    "--keep-daily",
    String(retention.daily),
    "--keep-weekly",
    String(retention.weekly),
    "--keep-monthly",
    String(retention.monthly),
    "--keep-yearly",
    String(retention.yearly),
    "--prune",
  ], { env: resticEnvironment(destination) });
  if (forgotten.isErr()) {
    return forgotten;
  }
  console.log(forgotten.value);
  return Result.ok();
}

function archiveTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function parseArchiveTimestamp(value: string): Date | undefined {
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/,
  );
  if (!match) {
    return undefined;
  }
  const date = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${
      match[7]
    }Z`,
  );
  if (Number.isNaN(date.getTime()) || archiveTimestamp(date) !== value) {
    return undefined;
  }
  return date;
}

export function parseProtonSnapshots(
  jobName: string,
  fileNames: string[],
): AppResult<ProtonSnapshot[]> {
  const escapedJobName = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${escapedJobName}-(\\d{8}T\\d{9}Z)\\.tar\\.zst$`,
  );
  const names = new Set(fileNames);
  const snapshots: ProtonSnapshot[] = [];
  for (const fileName of names) {
    const match = fileName.match(pattern);
    if (!match) {
      continue;
    }
    if (!names.has(`${fileName}.sha256`)) {
      return Result.err(
        new Error(`Proton archive has no checksum file: ${fileName}`),
      );
    }
    const timestamp = match[1];
    if (!timestamp) {
      return Result.err(new Error(`Invalid Proton archive name: ${fileName}`));
    }
    const createdAt = parseArchiveTimestamp(timestamp);
    if (!createdAt) {
      return Result.err(
        new Error(`Invalid Proton archive timestamp: ${fileName}`),
      );
    }
    snapshots.push({ archiveName: fileName, createdAt });
  }
  for (const fileName of names) {
    if (!fileName.endsWith(".tar.zst.sha256")) {
      continue;
    }
    const archiveName = fileName.slice(0, -".sha256".length);
    if (pattern.test(archiveName) && !names.has(archiveName)) {
      return Result.err(
        new Error(`Proton checksum has no archive file: ${fileName}`),
      );
    }
  }
  snapshots.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return Result.ok(snapshots);
}

function isoWeekKey(date: Date): string {
  const day = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const weekDay = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekDay);
  const weekYear = day.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(
    (((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7,
  );
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

export function selectProtonSnapshotsToKeep(
  snapshots: ProtonSnapshot[],
  retention: Retention,
): Set<string> {
  const sorted = [...snapshots].sort((a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime()
  );
  const keep = new Set<string>();
  const policies: Array<{
    count: number;
    key: (date: Date) => string;
  }> = [
    {
      count: retention.daily,
      key: (date) => date.toISOString().slice(0, 10),
    },
    { count: retention.weekly, key: isoWeekKey },
    {
      count: retention.monthly,
      key: (date) => date.toISOString().slice(0, 7),
    },
    {
      count: retention.yearly,
      key: (date) => String(date.getUTCFullYear()),
    },
  ];
  for (const policy of policies) {
    const periods = new Set<string>();
    for (const snapshot of sorted) {
      const period = policy.key(snapshot.createdAt);
      if (periods.has(period)) {
        continue;
      }
      if (periods.size >= policy.count) {
        break;
      }
      periods.add(period);
      keep.add(snapshot.archiveName);
    }
  }
  return keep;
}

async function createProtonArchive(
  job: Job,
  stageDirectory: string,
  destination: ProtonDriveDestination,
): Promise<AppResult<void>> {
  const outbox = await ensureDirectory(destination.outbox);
  if (outbox.isErr()) {
    return outbox;
  }
  const baseName = `${job.name}-${archiveTimestamp(new Date())}.tar`;
  const tarPath = `${destination.outbox}/.${baseName}.partial`;
  const compressedPath = `${destination.outbox}/${baseName}.zst`;
  const compressedPartial = `${compressedPath}.partial`;
  const checksumPath = `${compressedPath}.sha256`;
  const checksumPartial = `${checksumPath}.partial`;
  const stageName = stageDirectory.slice(stageDirectory.lastIndexOf("/") + 1);
  const stageParent = stageDirectory.slice(0, stageDirectory.lastIndexOf("/"));

  const archived = await runCommand("tar", [
    "--create",
    "--file",
    tarPath,
    "--directory",
    stageParent,
    stageName,
  ]);
  if (archived.isErr()) {
    await removeIfPresent(tarPath);
    return archived;
  }
  const compressed = await runCommand("zstd", [
    "--quiet",
    "--threads=0",
    tarPath,
    "-o",
    compressedPartial,
  ]);
  if (compressed.isErr()) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    return compressed;
  }
  const verified = await runCommand("zstd", [
    "--quiet",
    "--test",
    compressedPartial,
  ]);
  if (verified.isErr()) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    return verified;
  }
  const checksum = await runCommand("sha256sum", [compressedPartial]);
  if (checksum.isErr()) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    return checksum;
  }
  const hash = checksum.value.split(/\s+/)[0];
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    return Result.err(
      new Error("Could not calculate the Proton archive checksum"),
    );
  }
  const checksumWritten = await Result.tryPromise(() =>
    Deno.writeTextFile(
      checksumPartial,
      `${hash}  ${compressedPath.slice(compressedPath.lastIndexOf("/") + 1)}\n`,
    )
  );
  if (checksumWritten.isErr()) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    await removeIfPresent(checksumPartial);
    return checksumWritten;
  }
  const checksumRenamed = await Result.tryPromise(() =>
    Deno.rename(checksumPartial, checksumPath)
  );
  if (checksumRenamed.isErr()) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    await removeIfPresent(checksumPartial);
    return checksumRenamed;
  }
  const archiveRenamed = await Result.tryPromise(() =>
    Deno.rename(compressedPartial, compressedPath)
  );
  if (archiveRenamed.isErr()) {
    await removeIfPresent(tarPath);
    await removeIfPresent(compressedPartial);
    await removeIfPresent(checksumPath);
    return archiveRenamed;
  }
  const removed = await removeIfPresent(tarPath);
  if (removed.isErr()) {
    return removed;
  }
  return Result.ok();
}

function protonPathParts(path: string): AppResult<string[]> {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts[0] !== "my-files" || parts.length < 2) {
    return Result.err(new Error(`Invalid Proton Drive folder: ${path}`));
  }
  if (
    parts.some((part) => part === "." || part === ".." || part.includes("\\"))
  ) {
    return Result.err(new Error(`Unsafe Proton Drive folder: ${path}`));
  }
  return Result.ok(parts);
}

async function ensureProtonFolder(path: string): Promise<AppResult<void>> {
  const parts = protonPathParts(path);
  if (parts.isErr()) {
    return parts;
  }
  let parent = "/my-files";
  for (const part of parts.value.slice(1)) {
    const current = `${parent}/${part}`;
    const exists = await runCommand(
      "proton-drive",
      ["filesystem", "info", current],
      { env: protonDriveEnvironment() },
    );
    if (exists.isErr()) {
      const created = await runCommand(
        "proton-drive",
        ["filesystem", "create-folder", parent, part],
        { env: protonDriveEnvironment() },
      );
      if (created.isErr()) {
        return Result.err(
          new Error(`Could not find or create Proton Drive folder ${current}`),
        );
      }
    }
    parent = current;
  }
  return Result.ok();
}

async function protonOutboxArchives(
  destination: ProtonDriveDestination,
): Promise<AppResult<string[]>> {
  const entries = await Result.tryPromise(async () => {
    const paths: string[] = [];
    for await (const entry of Deno.readDir(destination.outbox)) {
      if (entry.isFile && entry.name.endsWith(".tar.zst")) {
        paths.push(`${destination.outbox}/${entry.name}`);
      }
    }
    return paths.sort();
  });
  return entries;
}

async function verifyProtonArchivePair(
  archivePath: string,
): Promise<AppResult<void>> {
  const checksumPath = `${archivePath}.sha256`;
  const files = await Result.tryPromise(async () => {
    const archive = await Deno.stat(archivePath);
    const checksum = await Deno.stat(checksumPath);
    if (!archive.isFile || !checksum.isFile) {
      return Promise.reject(
        new Error(
          `Queued Proton archive pair must contain regular files: ${archivePath}`,
        ),
      );
    }
  });
  if (files.isErr()) {
    return Result.err(
      new Error(`Queued Proton archive is incomplete: ${archivePath}`),
    );
  }
  const archiveName = archivePath.slice(archivePath.lastIndexOf("/") + 1);
  const checksumName = `${archiveName}.sha256`;
  const outbox = archivePath.slice(0, archivePath.lastIndexOf("/"));
  const checksum = await runCommand("sha256sum", ["--check", checksumName], {
    cwd: outbox,
  });
  if (checksum.isErr()) {
    return checksum;
  }
  const compressed = await runCommand("zstd", [
    "--quiet",
    "--test",
    archivePath,
  ]);
  if (compressed.isErr()) {
    return compressed;
  }
  return Result.ok();
}

function protonNodeName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const result = asRecord(value);
  if (result?.ok === true && typeof result.value === "string") {
    return result.value;
  }
  return undefined;
}

export function parseProtonFileNames(output: string): AppResult<string[]> {
  const parsed = Result.try(() => JSON.parse(output) as unknown);
  if (parsed.isErr()) {
    return Result.err(new Error("Proton Drive returned invalid JSON"));
  }
  if (!Array.isArray(parsed.value)) {
    return Result.err(new Error("Proton Drive file listing was not an array"));
  }
  const names: string[] = [];
  for (const item of parsed.value) {
    const node = asRecord(item);
    const name = node ? protonNodeName(node.name) : undefined;
    if (!name) {
      return Result.err(
        new Error("Proton Drive returned a file with no readable name"),
      );
    }
    names.push(name);
  }
  return Result.ok(names);
}

async function listProtonFileNames(
  destination: ProtonDriveDestination,
): Promise<AppResult<string[]>> {
  const listed = await runCommand("proton-drive", [
    "filesystem",
    "list",
    "--json",
    "--type",
    "file",
    destination.remoteFolder,
  ], { env: protonDriveEnvironment() });
  if (listed.isErr()) {
    return listed;
  }
  return parseProtonFileNames(listed.value);
}

async function applyProtonRetention(
  job: Job,
  destination: ProtonDriveDestination,
): Promise<AppResult<void>> {
  const fileNames = await listProtonFileNames(destination);
  if (fileNames.isErr()) {
    return fileNames;
  }
  const snapshots = parseProtonSnapshots(job.name, fileNames.value);
  if (snapshots.isErr()) {
    return snapshots;
  }
  const keep = selectProtonSnapshotsToKeep(snapshots.value, job.retention);
  const expired = snapshots.value.filter((snapshot) =>
    !keep.has(snapshot.archiveName)
  );
  if (expired.length === 0) {
    return Result.ok();
  }
  const paths = expired.flatMap((snapshot) => [
    `${destination.remoteFolder}/${snapshot.archiveName}`,
    `${destination.remoteFolder}/${snapshot.archiveName}.sha256`,
  ]);
  const trashed = await runCommand(
    "proton-drive",
    ["filesystem", "trash", "--json", ...paths],
    { env: protonDriveEnvironment() },
  );
  if (trashed.isErr()) {
    return trashed;
  }
  const remaining = await listProtonFileNames(destination);
  if (remaining.isErr()) {
    return remaining;
  }
  const remainingNames = new Set(remaining.value);
  for (const snapshot of expired) {
    if (
      remainingNames.has(snapshot.archiveName) ||
      remainingNames.has(`${snapshot.archiveName}.sha256`)
    ) {
      return Result.err(
        new Error(
          `Proton Drive did not confirm removal of ${snapshot.archiveName}`,
        ),
      );
    }
  }
  console.log(
    `Moved ${expired.length} expired Proton archive pair(s) to trash`,
  );
  return Result.ok();
}

async function uploadProtonOutbox(
  destination: ProtonDriveDestination,
): Promise<AppResult<void>> {
  const folder = await ensureProtonFolder(destination.remoteFolder);
  if (folder.isErr()) {
    return folder;
  }
  const archives = await protonOutboxArchives(destination);
  if (archives.isErr()) {
    return archives;
  }
  for (const archivePath of archives.value) {
    const checksumPath = `${archivePath}.sha256`;
    const verified = await verifyProtonArchivePair(archivePath);
    if (verified.isErr()) {
      return verified;
    }
    const uploaded = await runCommand("proton-drive", [
      "filesystem",
      "upload",
      "--file-conflict-strategy",
      "skip",
      "--skip-thumbnails",
      archivePath,
      checksumPath,
      destination.remoteFolder,
    ], { env: protonDriveEnvironment() });
    if (uploaded.isErr()) {
      return uploaded;
    }
    const archiveName = archivePath.slice(archivePath.lastIndexOf("/") + 1);
    const checksumName = checksumPath.slice(checksumPath.lastIndexOf("/") + 1);
    for (const name of [archiveName, checksumName]) {
      const confirmed = await runCommand(
        "proton-drive",
        ["filesystem", "info", `${destination.remoteFolder}/${name}`],
        { env: protonDriveEnvironment() },
      );
      if (confirmed.isErr()) {
        return Result.err(
          new Error(`Proton Drive did not confirm upload of ${name}`),
        );
      }
    }
    const archiveRemoved = await removeIfPresent(archivePath);
    if (archiveRemoved.isErr()) {
      return archiveRemoved;
    }
    const checksumRemoved = await removeIfPresent(checksumPath);
    if (checksumRemoved.isErr()) {
      return checksumRemoved;
    }
  }
  return Result.ok();
}

async function backupProtonDrive(
  job: Job,
  stageDirectory: string,
  destination: ProtonDriveDestination,
): Promise<AppResult<void>> {
  const archived = await createProtonArchive(job, stageDirectory, destination);
  if (archived.isErr()) {
    return archived;
  }
  const uploaded = await uploadProtonOutbox(destination);
  if (uploaded.isErr()) {
    return uploaded;
  }
  return await applyProtonRetention(job, destination);
}

async function initialize(job: Job): Promise<AppResult<void>> {
  const drive = await checkBackupDrive(job);
  if (drive.isErr()) {
    return drive;
  }
  const errors: string[] = [];
  for (const destination of job.destinations) {
    if (destination.type === "restic") {
      const initialized = await initializeRestic(destination);
      if (initialized.isErr()) {
        errors.push(`${destination.type}: ${initialized.error.message}`);
      }
    }
    if (destination.type === "proton-drive") {
      const outbox = await ensureDirectory(destination.outbox);
      if (outbox.isErr()) {
        errors.push(`${destination.type}: ${outbox.error.message}`);
        continue;
      }
      const folder = await ensureProtonFolder(destination.remoteFolder);
      if (folder.isErr()) {
        errors.push(`${destination.type}: ${folder.error.message}`);
      }
    }
  }
  if (errors.length > 0) {
    return Result.err(new Error(errors.join("; ")));
  }
  return Result.ok();
}

async function backup(job: Job): Promise<AppResult<void>> {
  const drive = await checkBackupDrive(job);
  if (drive.isErr()) {
    return drive;
  }
  const staged = await stageSource(job);
  if (staged.isErr()) {
    return staged;
  }

  const errors: string[] = [];
  for (const destination of job.destinations) {
    const backedUp = destination.type === "restic"
      ? await backupRestic(job, staged.value, destination)
      : await backupProtonDrive(job, staged.value, destination);
    if (backedUp.isErr()) {
      errors.push(`${destination.type}: ${backedUp.error.message}`);
      console.error(`Destination failed: ${destination.type}`);
    }
  }
  if (errors.length > 0) {
    return Result.err(new Error(errors.join("; ")));
  }
  return Result.ok();
}

async function checkRestic(
  destination: ResticDestination,
  readData: boolean,
): Promise<AppResult<void>> {
  const checkedDestination = await checkResticDestination(destination);
  if (checkedDestination.isErr()) {
    return checkedDestination;
  }
  const args = readData ? ["check", "--read-data"] : ["check"];
  const checked = await runCommand("restic", args, {
    env: resticEnvironment(destination),
  });
  if (checked.isErr()) {
    return checked;
  }
  console.log(checked.value);
  return Result.ok();
}

async function checkProtonDrive(
  job: Job,
  destination: ProtonDriveDestination,
): Promise<AppResult<void>> {
  const outbox = await ensureDirectory(destination.outbox);
  if (outbox.isErr()) {
    return outbox;
  }
  const folder = await ensureProtonFolder(destination.remoteFolder);
  if (folder.isErr()) {
    return folder;
  }
  const queued = await protonOutboxArchives(destination);
  if (queued.isErr()) {
    return queued;
  }
  for (const archivePath of queued.value) {
    const verified = await verifyProtonArchivePair(archivePath);
    if (verified.isErr()) {
      return verified;
    }
  }
  const fileNames = await listProtonFileNames(destination);
  if (fileNames.isErr()) {
    return fileNames;
  }
  const snapshots = parseProtonSnapshots(job.name, fileNames.value);
  if (snapshots.isErr()) {
    return snapshots;
  }
  return Result.ok();
}

async function check(job: Job, readData: boolean): Promise<AppResult<void>> {
  const drive = await checkBackupDrive(job);
  if (drive.isErr()) {
    return drive;
  }
  const errors: string[] = [];
  for (const destination of job.destinations) {
    const checked = destination.type === "restic"
      ? await checkRestic(destination, readData)
      : await checkProtonDrive(job, destination);
    if (checked.isErr()) {
      errors.push(`${destination.type}: ${checked.error.message}`);
    }
  }
  if (errors.length > 0) {
    return Result.err(new Error(errors.join("; ")));
  }
  return Result.ok();
}

async function main(): Promise<AppResult<void>> {
  const action = Deno.args[0];
  const jobPath = Deno.args[1] ?? "/job/backup.job.json";
  if (
    !action || !["init", "backup", "check", "check-read-data"].includes(action)
  ) {
    return Result.err(
      new Error(
        "Usage: backup-runner <init|backup|check|check-read-data> [job-file]",
      ),
    );
  }
  const job = await loadJob(jobPath);
  if (job.isErr()) {
    return job;
  }
  switch (action) {
    case "init":
      return await initialize(job.value);
    case "backup":
      return await backup(job.value);
    case "check":
      return await check(job.value, false);
    case "check-read-data":
      return await check(job.value, true);
    default:
      return Result.err(new Error(`Unsupported action: ${action}`));
  }
}

if (import.meta.main) {
  const result = await main();
  if (result.isErr()) {
    console.error(`Backup failed: ${result.error.message}`);
    Deno.exitCode = 1;
  }
}
