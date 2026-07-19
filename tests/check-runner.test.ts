import assert from "node:assert/strict";
import test from "node:test";
import { parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { FetchResult, SnapshotStore } from "@kontourai/forage/fetch";
import { createCheckRunner } from "../src/check-runner.js";
import type { StructuredFileLookoutSource } from "../src/registry.js";
import { memoryStore, snapshot, source } from "./helpers.js";

test("AC1 --all returns one ordered result per registered source and stores both fresh snapshots", async () => {
  const store = memoryStore();
  const sources = [source("first"), source("second")];
  const runner = createCheckRunner({
    store,
    fetchSource: async ({ id }) => ({ snapshot: snapshot(id, `body-${id}`) }),
    clock: () => "2026-07-10T12:01:00.000Z",
  });
  const results = await runner.checkAll(sources);
  assert.deepEqual(results.map((result) => result.sourceId), ["first", "second"]);
  assert.deepEqual(results.map((result) => result.kind), ["changed", "changed"]);
  assert.deepEqual(store.puts.map((item) => item.sourceId), ["first", "second"]);
});

test("AC2 validator recheck returns unchanged-304 and never reads the 304 body", async () => {
  const prior = snapshot("alpha", "prior", { headers: { etag: '"v1"' } });
  const served = new Proxy(
    { ...prior, fromCache: true, notModified: true },
    {
      get(target, property, receiver) {
        if (property === "body") throw new Error("304 body was read");
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const store = memoryStore([prior]);
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: served }) }).check(source("alpha"));
  assert.equal(result.kind, "unchanged-304");
  assert.equal(store.puts.length, 0);
});

test("a malformed 304 without the matching prior capture is a dependency-contract error", async () => {
  const served = { ...snapshot("alpha", "served"), fromCache: true, notModified: true };
  const noPrior = await createCheckRunner({
    store: memoryStore(),
    fetchSource: async () => ({ snapshot: served }),
  }).check(source("alpha"));
  assert.equal(noPrior.kind, "error");
  if (noPrior.kind === "error") {
    assert.equal(noPrior.origin, "lookout");
    assert.equal(noPrior.error.kind, "dependency-contract");
  }

  const mismatched = await createCheckRunner({
    store: memoryStore([snapshot("alpha", "prior")]),
    fetchSource: async () => ({ snapshot: served }),
  }).check(source("alpha"));
  assert.equal(mismatched.kind, "error");
  if (mismatched.kind === "error") {
    assert.equal(mismatched.origin, "lookout");
    assert.equal(mismatched.error.kind, "dependency-contract");
  }

  for (const changedMetadata of [
    { headers: { etag: '"v2"' } },
    { redirects: ["https://example.test/redirect"] },
    { rendered: true },
    { body: new TextEncoder().encode("served") },
  ]) {
    const prior = snapshot("alpha", "served", { headers: { etag: '"v1"' } });
    const metadataMismatch = await createCheckRunner({
      store: memoryStore([prior]),
      fetchSource: async () => ({ snapshot: { ...prior, ...changedMetadata, notModified: true } }),
    }).check(source("alpha"));
    assert.equal(metadataMismatch.kind, "error");
    if (metadataMismatch.kind === "error") {
      assert.equal(metadataMismatch.error.kind, "dependency-contract");
    }
  }

  const prior = snapshot("alpha", "served");
  const accessorBody = { ...prior, notModified: true };
  Object.defineProperty(accessorBody, "body", { get() { throw new Error("304 body was read"); }, enumerable: true });
  const unknownRepresentation = await createCheckRunner({
    store: memoryStore([prior]),
    fetchSource: async () => ({ snapshot: accessorBody }),
  }).check(source("alpha"));
  assert.equal(unknownRepresentation.kind, "error");
  if (unknownRepresentation.kind === "error") {
    assert.equal(unknownRepresentation.error.kind, "dependency-contract");
  }
});

test("AC2 validator-free identical body returns unchanged-hash from prior hash comparison", async () => {
  const prior = snapshot("alpha", "same", { fetchedAt: "2026-07-10T10:00:00.000Z" });
  const current = snapshot("alpha", "same", { fetchedAt: "2026-07-10T11:00:00.000Z" });
  const store = memoryStore([prior]);
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: current }) }).check(source("alpha"));
  assert.equal(result.kind, "unchanged-hash");
  assert.equal(store.puts.length, 1);
});

test("AC3 changed body returns changed with resolvable prior and current refs", async () => {
  const prior = snapshot("alpha", "old", { fetchedAt: "2026-07-10T10:00:00.000Z" });
  const current = snapshot("alpha", "new", { fetchedAt: "2026-07-10T11:00:00.000Z" });
  const store = memoryStore([prior]);
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: current }) }).check(source("alpha"));
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") return;
  assert.equal(result.changeBasis, "hash");
  const priorRef = parseSnapshotSourceRef(result.priorSnapshotRef as string);
  const currentRef = parseSnapshotSourceRef(result.currentSnapshotRef);
  assert.equal((await store.get("alpha", priorRef?.bodyHash ?? "missing"))?.body, "old");
  assert.equal((await store.get("alpha", currentRef?.bodyHash ?? "missing"))?.body, "new");
});

test("registered-source SSRF: a link-local/metadata target is refused by the default guarded egress", async () => {
  const store = memoryStore();
  // No fetchSource / fetchOptions.fetch injected → the forage-guarded default
  // transport. 169.254.169.254 is link-local, so the guard denies it before any
  // connection (no DNS, deterministic). The drift check surfaces a typed Forage
  // error rather than fetching an internal endpoint — a registered source can
  // never be turned into an SSRF vector.
  // Silence retry backoff timers only — `fetch` stays defaulted to the guard.
  const result = await createCheckRunner({
    store,
    fetchOptions: { sleep: async () => {}, random: () => 0 },
  }).check(source("metadata", { url: "http://169.254.169.254/latest/meta-data/" }));
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.origin, "forage");
  assert.equal(store.puts.length, 0);
});

test("AC4 Forage network error is preserved and check never rejects", async () => {
  const error = { kind: "network" as const, message: "connection reset" };
  const result = await createCheckRunner({ store: memoryStore(), fetchSource: async () => ({ error }) }).check(source());
  assert.deepEqual(result, {
    kind: "error",
    origin: "forage",
    error,
    sourceId: "source-a",
    sourceUrl: "https://example.test/source-a",
    checkedAt: result.checkedAt,
    warnings: [],
  });
});

test("first successful observation is changed with initial basis and a null prior ref", async () => {
  const store = memoryStore();
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: snapshot("alpha", "first") }) }).check(source("alpha"));
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") return;
  assert.equal(result.changeBasis, "initial");
  assert.equal(result.priorSnapshotRef, null);
});

test("classification mutation guard flips red when equal and unequal hash branches are swapped", async () => {
  const prior = snapshot("alpha", "same", { fetchedAt: "2026-07-10T10:00:00.000Z" });
  const equal = await createCheckRunner({ store: memoryStore([prior]), fetchSource: async () => ({ snapshot: snapshot("alpha", "same") }) }).check(source("alpha"));
  const unequal = await createCheckRunner({ store: memoryStore([prior]), fetchSource: async () => ({ snapshot: snapshot("alpha", "different") }) }).check(source("alpha"));
  assert.equal(equal.kind, "unchanged-hash");
  assert.equal(unequal.kind, "changed");
});

test("persistence mutation guard flips red when fresh snapshot put is skipped", async () => {
  const store = memoryStore();
  const current = snapshot("alpha", "fresh");
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: current }) }).check(source("alpha"));
  assert.equal(result.kind, "changed");
  assert.equal(store.puts.length, 1);
  assert.equal((await store.get("alpha", current.bodyHash))?.body, "fresh");
});

test("error propagation mutation guard flips red when a Forage error is swallowed", async () => {
  const result = await createCheckRunner({
    store: memoryStore(),
    fetchSource: async () => ({ error: { kind: "timeout", message: "deadline" } }),
  }).check(source("alpha"));
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.origin, "forage");
  assert.equal(result.error.kind, "timeout");
});

test("store read rejection becomes a lookout error and check never rejects", async () => {
  const store = rejectingStore("read");
  const result = await createCheckRunner({ store, fetchSource: async () => { throw new Error("must not fetch"); } }).check(source());
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.origin, "lookout");
  assert.equal(result.error.kind, "prior-read");
});

test("store write rejection emits no successful classification and check never rejects", async () => {
  const store = rejectingStore("write");
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: snapshot("source-a", "fresh") }) }).check(source());
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.origin, "lookout");
  assert.equal(result.error.kind, "persistence");
});

test("checkAll continues after one source error and preserves registry order", async () => {
  const result = await createCheckRunner({
    store: memoryStore(),
    fetchSource: async ({ id }): Promise<FetchResult> => id === "bad"
      ? { error: { kind: "timeout", message: "slow" } }
      : { snapshot: snapshot(id, id) },
  }).checkAll([source("first"), source("bad"), source("last")]);
  assert.deepEqual(result.map((item) => [item.sourceId, item.kind]), [
    ["first", "changed"], ["bad", "error"], ["last", "changed"],
  ]);
});

test("renderPolicy is inert registry data during L1 checks", async () => {
  const configs: unknown[] = [];
  const runner = createCheckRunner({
    store: memoryStore(),
    fetchSource: async (config) => { configs.push(config); return { snapshot: snapshot(config.id, "body") }; },
  });
  await runner.check(source("alpha", { renderPolicy: "always" }));
  assert.deepEqual(configs, [{ id: "alpha", url: "https://example.test/alpha", egress: { guarded: true } }]);
});

test("structured files use the same guarded fetch, raw snapshot, and drift classification", async () => {
  const structured: StructuredFileLookoutSource = {
    id: "published-results",
    kind: "structured-file",
    format: "yaml",
    url: "https://example.test/results.yml",
    cadenceHint: "weekly",
  };
  const body = "score: 42\n";
  const store = memoryStore();
  const configs: unknown[] = [];
  const result = await createCheckRunner({
    store,
    fetchSource: async (config) => {
      configs.push(config);
      return { snapshot: snapshot(config.id, body, { url: config.url }) };
    },
  }).check(structured);

  assert.equal(result.kind, "changed");
  assert.deepEqual(configs, [{
    id: "published-results",
    url: "https://example.test/results.yml",
    egress: { guarded: true },
  }]);
  assert.equal(store.puts[0]?.body, body);
});

test("L1 check does not invoke the datum resolver", async () => {
  let calls = 0;
  const runner = createCheckRunner({
    store: memoryStore(),
    fetchSource: async () => ({ snapshot: snapshot("alpha", "body") }),
    providerResolver: (() => { calls += 1; throw new Error("must remain lazy"); }) as never,
  });
  assert.equal((await runner.check(source("alpha"))).kind, "changed");
  assert.equal(calls, 0);
});

test("L-1 hostile fetch returning {snapshot: null} yields a dependency-contract error and never rejects", async () => {
  const result = await createCheckRunner({
    store: memoryStore(),
    fetchSource: async () => ({ snapshot: null }) as unknown as FetchResult,
  }).check(source("alpha"));
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.origin, "lookout");
  assert.equal(result.error.kind, "dependency-contract");
});

test("L-1 hostile fetch returning {error: null} yields a dependency-contract error and never rejects", async () => {
  const result = await createCheckRunner({
    store: memoryStore(),
    fetchSource: async () => ({ error: null }) as unknown as FetchResult,
  }).check(source("alpha"));
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.origin, "lookout");
  assert.equal(result.error.kind, "dependency-contract");
});

test("L-2 source url change with identical body classifies changed (moved resource re-baselines)", async () => {
  const prior = snapshot("alpha", "same", { url: "https://example.test/old", fetchedAt: "2026-07-10T10:00:00.000Z" });
  const current = snapshot("alpha", "same", { fetchedAt: "2026-07-10T11:00:00.000Z" });
  const store = memoryStore([prior]);
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: current }) }).check(source("alpha"));
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") return;
  assert.equal(result.changeBasis, "hash");
  assert.equal(store.puts.length, 1); // fresh snapshot persisted as the new baseline
});

test("L-2 source url change with different body classifies changed", async () => {
  const prior = snapshot("alpha", "old", { url: "https://example.test/old", fetchedAt: "2026-07-10T10:00:00.000Z" });
  const current = snapshot("alpha", "new", { fetchedAt: "2026-07-10T11:00:00.000Z" });
  const store = memoryStore([prior]);
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: current }) }).check(source("alpha"));
  assert.equal(result.kind, "changed");
  assert.equal(store.puts.length, 1);
});

test("L-2 same url with identical body still classifies unchanged-hash", async () => {
  const prior = snapshot("alpha", "same", { fetchedAt: "2026-07-10T10:00:00.000Z" });
  const current = snapshot("alpha", "same", { fetchedAt: "2026-07-10T11:00:00.000Z" });
  const store = memoryStore([prior]);
  const result = await createCheckRunner({ store, fetchSource: async () => ({ snapshot: current }) }).check(source("alpha"));
  assert.equal(result.kind, "unchanged-hash");
  assert.equal(store.puts.length, 1);
});

function rejectingStore(mode: "read" | "write"): SnapshotStore {
  return {
    async put() { if (mode === "write") throw new Error("disk full"); },
    async latest() { if (mode === "read") throw new Error("read denied"); return undefined; },
    async get() { return undefined; },
    async list() { return []; },
  };
}
