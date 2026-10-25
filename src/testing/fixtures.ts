export const fixture = {
  version: 1,
  name: "test-job",
  host: "test-host",
  source: { type: "sqlite", path: "/source/test.db", output: "test.db" },
  backupDrive: {
    sentinelFile: "/drive/.sentinel",
    driveSerial: "test",
    filesystemUuid: "test",
  },
  destinations: [
    { type: "restic", repository: "/drive/restic", passwordFile: "/password" },
    {
      type: "proton-drive",
      remoteFolder: "/my-files/Backups/test-job",
      outbox: "/drive/outbox",
    },
  ],
  retention: { daily: 14, weekly: 8, monthly: 12, yearly: 5 },
};
