import assert from "node:assert/strict";
import test from "node:test";

import { BACKUP_FORMAT, createBackup, parseBackup } from "../static/backup.js";

test("creates and parses a single-file backup", () => {
  const relationshipStore = {
    version: 1,
    fetched_at: "2026-01-01T00:00:00.000Z",
    relationships: [{ id: "123", type_name: "friend", token: "must-not-export" }],
  };
  const operations = [{ id: "op-1", action: "remove_friend", user: { id: "123", authorization: "must-not-export" } }];
  const backup = createBackup(relationshipStore, operations, "2026-02-01T00:00:00.000Z");

  assert.equal(backup.format, BACKUP_FORMAT);
  assert.deepEqual(parseBackup(JSON.stringify(backup)), backup);
  assert.equal(JSON.stringify(backup).includes("must-not-export"), false);
});

test("rejects unrelated or malformed backup files", () => {
  assert.throws(() => parseBackup("not json"), /JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ format: "other", version: 1 })), /支援/);
  assert.throws(() => parseBackup(JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    relationships: { version: 1, relationships: [{ username: "missing-id" }] },
    operations: [],
  })), /好友資料/);
});
