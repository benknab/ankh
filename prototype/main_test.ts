import { assertEquals } from "jsr:@std/assert@1.0.15";
import {
  parseJob,
  parseProtonFileNames,
  parseProtonSnapshots,
  parseSentinel,
  type ProtonSnapshot,
  selectProtonSnapshotsToKeep,
} from "./main.ts";

const validJob = {
  version: 1,
  name: "example-app",
  host: "example-host",
  source: {
    type: "sqlite",
    path: "/source/example-app.db",
    output: "example-app.db",
  },
  backupDrive: {
    sentinelFile: "/backup-drive/.backup-drive-sentinel",
    driveSerial: "EXAMPLE-DRIVE-SERIAL",
    filesystemUuid: "00000000-0000-4000-8000-000000000001",
  },
  destinations: [
    {
      type: "restic",
      repository: "/backup-drive/restic",
      passwordFile: "/run/secrets/restic-password",
    },
    {
      type: "proton-drive",
      remoteFolder: "/my-files/Backups/example-app",
      outbox: "/backup-drive/outbox/example-app",
    },
  ],
  retention: {
    daily: 14,
    weekly: 8,
    monthly: 12,
    yearly: 5,
  },
};

Deno.test("parseJob accepts a valid SQLite job", () => {
  const result = parseJob(validJob);
  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value.name, "example-app");
    assertEquals(result.value.source.type, "sqlite");
  }
});

Deno.test("parseJob rejects unsafe output names", () => {
  const result = parseJob({
    ...validJob,
    source: { ...validJob.source, output: "../database" },
  });
  assertEquals(result.isErr(), true);
});

Deno.test("parseJob rejects duplicate destination types", () => {
  const result = parseJob({
    ...validJob,
    destinations: [validJob.destinations[0], validJob.destinations[0]],
  });
  assertEquals(result.isErr(), true);
});

Deno.test("parseSentinel reads expected values", () => {
  assertEquals(
    parseSentinel("serial=drive\nuuid=filesystem\nlabel=restic-backup\n"),
    new Map([
      ["serial", "drive"],
      ["uuid", "filesystem"],
      ["label", "restic-backup"],
    ]),
  );
});

Deno.test("parseProtonFileNames reads CLI result names", () => {
  const result = parseProtonFileNames(JSON.stringify([
    { type: "file", name: { ok: true, value: "one.tar.zst" } },
    { type: "file", name: "two.tar.zst" },
  ]));
  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value, ["one.tar.zst", "two.tar.zst"]);
  }
});

Deno.test("parseProtonSnapshots requires complete archive pairs", () => {
  const archive = "example-app-20260920T033000000Z.tar.zst";
  const complete = parseProtonSnapshots("example-app", [
    archive,
    `${archive}.sha256`,
    "unrelated.txt",
  ]);
  assertEquals(complete.isOk(), true);
  if (complete.isOk()) {
    assertEquals(complete.value.length, 1);
    assertEquals(
      complete.value.at(0)?.createdAt.toISOString(),
      "2026-09-20T03:30:00.000Z",
    );
  }

  const incomplete = parseProtonSnapshots("example-app", [archive]);
  assertEquals(incomplete.isErr(), true);
});

Deno.test("selectProtonSnapshotsToKeep keeps newest snapshot in each period", () => {
  const source: Array<[string, string]> = [
    ["newest", "2026-01-01T20:00:00.000Z"],
    ["same-day", "2026-01-01T10:00:00.000Z"],
    ["same-iso-week", "2025-12-31T20:00:00.000Z"],
    ["prior-week", "2025-12-20T20:00:00.000Z"],
  ];
  const snapshots: ProtonSnapshot[] = source.map((
    [archiveName, timestamp],
  ) => ({
    archiveName,
    createdAt: new Date(timestamp),
  }));

  assertEquals(
    selectProtonSnapshotsToKeep(snapshots, {
      daily: 1,
      weekly: 2,
      monthly: 0,
      yearly: 0,
    }),
    new Set(["newest", "prior-week"]),
  );
});

Deno.test("selectProtonSnapshotsToKeep honors each configured count", () => {
  const cases: Array<{
    policy: "daily" | "weekly" | "monthly" | "yearly";
    dates: string[];
    expected: number;
  }> = [
    {
      policy: "daily",
      dates: Array.from(
        { length: 20 },
        (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}T03:30:00Z`,
      ),
      expected: 14,
    },
    {
      policy: "weekly",
      dates: Array.from(
        { length: 12 },
        (_, index) =>
          new Date(Date.UTC(2026, 0, 5 + (index * 7))).toISOString(),
      ),
      expected: 8,
    },
    {
      policy: "monthly",
      dates: Array.from(
        { length: 16 },
        (_, index) => new Date(Date.UTC(2025, index, 1)).toISOString(),
      ),
      expected: 12,
    },
    {
      policy: "yearly",
      dates: Array.from(
        { length: 8 },
        (_, index) => new Date(Date.UTC(2019 + index, 0, 1)).toISOString(),
      ),
      expected: 5,
    },
  ];

  for (const testCase of cases) {
    const retention = { daily: 0, weekly: 0, monthly: 0, yearly: 0 };
    retention[testCase.policy] = testCase.expected;
    const snapshots = testCase.dates.map((timestamp, index) => ({
      archiveName: `${testCase.policy}-${index}`,
      createdAt: new Date(timestamp),
    }));
    assertEquals(
      selectProtonSnapshotsToKeep(snapshots, retention).size,
      testCase.expected,
    );
  }
});
