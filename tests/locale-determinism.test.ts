import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Each probe runs in a child process with LC_ALL set, because the collation
// locale is fixed when the process starts. en_US and sv_SE disagree on "Ä"
// versus "Z" (en_US puts Ä first, sv_SE puts it after Z), and every probe
// reports that comparison so a run that did not really switch locale fails.
const probe = fileURLToPath(new URL("./locale-probe.js", import.meta.url));
const locales = { "en_US.UTF-8": -1, "sv_SE.UTF-8": 1 } as const;
type Locale = keyof typeof locales;

function run(locale: Locale, ...args: string[]): Record<string, unknown> {
  const child = spawnSync(process.execPath, [probe, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: locale } });
  assert.equal(child.status, 0, `probe ${args.join(" ")} under ${locale} failed: ${child.stderr}`);
  const output = JSON.parse(child.stdout) as Record<string, unknown>;
  assert.equal(output.collation, locales[locale], `LC_ALL=${locale} did not change the child's collation`);
  return output;
}

// Pinned: sha256 of the version 2 canonical record for the probe's fixture observation.
const OBSERVATION_ID = "3d5a95f40405cacb0f88a41003ee54e911440c7c5fb23198448363deca81b2f8";

test("observation ids, proposal pairing and drift event order do not depend on the host locale", () => {
  for (const locale of Object.keys(locales) as Locale[]) {
    const output = run(locale, "summary");
    assert.deepEqual(output.observation, {
      id: OBSERVATION_ID,
      storedValues: ["Zz", "Äa", { b: 1, "10": 2, "9": 3, "äb": 4, zb: 5, B: 6 }],
    }, locale);
    // Prior values pair with current values in code-unit order: "Zz" before "Äa".
    assert.deepEqual(output.pairing, [["Zz", "Bb"], ["Äa", "Cc"]], locale);
    // Events are sorted by their code-unit canonical JSON, with keys in code-unit order too.
    assert.deepEqual(output.drift, [
      { kind: "case-keys", a: 2, B: 1 },
      { kind: "case-keys", a: 1, B: 2 },
      { kind: "field-changed", fieldKey: "Zz" },
      { kind: "field-changed", fieldKey: "Äa" },
      { kind: "value-keys", "ä": 2, z: 1 },
      { kind: "value-keys", "ä": 1, z: 2 },
    ], locale);
  }
});

test("a record written under one locale loads under another", async () => {
  for (const [writer, reader] of [["en_US.UTF-8", "sv_SE.UTF-8"], ["sv_SE.UTF-8", "en_US.UTF-8"]] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lookout-locale-"));
    try {
      assert.equal(run(writer, "write", root).write, OBSERVATION_ID);
      assert.equal(run(reader, "read", root).read, OBSERVATION_ID);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a version 1 record written under en_US still loads there and is replaced by a version 2 record", () => {
  // tests/fixtures/legacy-v1-observations was written by the version 1 store under LC_ALL=en_US.UTF-8.
  assert.deepEqual(run("en_US.UTF-8", "legacy").legacy, {
    load: "ok",
    version: 1,
    id: "497eee3c12ed9eea33dc9957b7636b12e81669b321b74eeffbb7e36cfcc0217f",
    commit: { version: 2 },
    reload: { version: 2, id: "5d0934c1f68dda568d8995bcdc20e4f023cc411d27b5bfab86f975df4e487b3b" },
  });
  // Documented limitation: a version 1 digest verifies only under a locale that
  // collates its keys the way the writing host did.
  assert.deepEqual(run("sv_SE.UTF-8", "legacy").legacy, { load: "corrupt-state", message: "Stored observation digest does not match its body" });
});
