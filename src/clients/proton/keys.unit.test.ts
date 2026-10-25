import { expect, it } from "@effect/vitest";
import { Array, Effect, Result } from "effect";
import { parseProtection, parseSecretKeys } from "#clients/proton/keys.ts";

const primary = "930CF490C7E7D549C32269B5F69663CD9738BE10";
const primaryGrip = "B30F89975CDFCF832544F1A734FB301A8929B2D7";
const subkeyGrip = "64867B4520B159917438382106B9967F92A21F4A";
const ankhKey = [
  "sec:u:3072:1:F69663CD9738BE10:1792958128:::u:::scESC:::+:::23::0:",
  `fpr:::::::::${primary}:`,
  `grp:::::::::${primaryGrip}:`,
  "uid:u::::1792958128::9FD8::Ankh <backup-runner@localhost>::::::::::0:",
  "ssb:u:3072:1:D6D7595512AA904A:1792958128::::::e:::+:::23:",
  "fpr:::::::::E143469E5FD982B488E02E0ED6D7595512AA904A:",
  `grp:::::::::${subkeyGrip}:`,
];
const signOnly = [
  "sec:u:255:22:AAAAAAAAAAAAAAAA:1792958128:::u:::scSC:::+:::ed25519::0:",
  "fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:",
  "grp:::::::::BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:",
  "uid:u::::1792958128::1234::Backup Runner <backup-runner@localhost>::::::::::0:",
];
const other = [
  "sec:u:3072:1:CCCCCCCCCCCCCCCC:1792958128:::u:::scESC:::+:::23::0:",
  "fpr:::::::::CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC:",
  "grp:::::::::DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD:",
  "uid:u::::1792958128::5678::Other <not-backup-runner@localhost.example>::::::::::0:",
];

it.effect("GPG listings select only exact Ankh identities with primary fingerprints", () =>
  Effect.gen(function* () {
    const keys = yield* parseSecretKeys(Array.join([...other, ...ankhKey, ""], "\n"));
    expect(keys).toEqual([
      {
        fingerprint: primary,
        keygrips: [primaryGrip, subkeyGrip],
        uids: ["Ankh <backup-runner@localhost>"],
        encrypts: true,
      },
    ]);
    const legacy = yield* parseSecretKeys(Array.join(signOnly, "\n"));
    expect(
      Array.map(legacy, (key) => key.encrypts),
      "sign-only keys need repair",
    ).toEqual([false]);
    const both = yield* parseSecretKeys(Array.join([...ankhKey, ...signOnly], "\n"));
    expect(both, "duplicate identities must stay visible so lookup can fail").toHaveLength(2);
    expect(yield* parseSecretKeys(""), "an empty key store has no keys").toEqual([]);
    const corrupt = yield* parseSecretKeys("sec:u:3072:1:X::::::::scESC:\nfpr:::::::::nope:").pipe(
      Effect.result,
    );
    expect(Result.isFailure(corrupt), "malformed fingerprints must fail closed").toBe(true);
  }),
);

const row = (grip: string, protection: string): string =>
  `S KEYINFO ${grip} D - - - ${protection} - - -`;

it.effect("GPG agent key info distinguishes protected, unprotected, and mixed keys", () =>
  Effect.gen(function* () {
    const [key] = yield* parseSecretKeys(Array.join(ankhKey, "\n"));
    if (key === undefined) {
      return yield* Effect.die("fixture key must parse");
    }
    const info = (first: string, second: string): string =>
      Array.join([row(primaryGrip, first), "OK", row(subkeyGrip, second), "OK", ""], "\n");
    expect(yield* parseProtection(key, info("P", "P"))).toBe("protected");
    expect(yield* parseProtection(key, info("C", "C"))).toBe("unprotected");
    expect(yield* parseProtection(key, info("P", "C"))).toBe("mixed");
    const missing = yield* parseProtection(key, `${row(primaryGrip, "P")}\nOK\n`).pipe(
      Effect.result,
    );
    expect(Result.isFailure(missing), "every key part must be reported").toBe(true);
  }),
);
