export const BACKUP_FORMAT = "discord-friend-manager-backup";
export const BACKUP_VERSION = 1;

function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["token", "access_token", "authorization"].includes(key.toLowerCase()))
    .map(([key, item]) => [key, withoutSecrets(item)]));
}

function validRelationship(item) {
  return item && typeof item === "object" && typeof item.id === "string" && item.id.length > 0;
}

function validOperation(item) {
  return item && typeof item === "object" && typeof item.id === "string"
    && typeof item.action === "string" && item.user && typeof item.user === "object";
}

export function createBackup(relationshipStore, operations, exportedAt = new Date().toISOString()) {
  const relationships = Array.isArray(relationshipStore?.relationships) ? withoutSecrets(relationshipStore.relationships) : [];
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: exportedAt,
    relationships: {
      version: 1,
      fetched_at: relationshipStore?.fetched_at || null,
      relationships,
    },
    operations: Array.isArray(operations) ? withoutSecrets(operations) : [],
  };
}

export function parseBackup(text) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("檔案不是有效的 JSON。");
  }
  if (backup?.format !== BACKUP_FORMAT || backup?.version !== BACKUP_VERSION) {
    throw new Error("這不是支援的 Discord Friend Manager 備份檔。");
  }
  if (backup.relationships?.version !== 1 || !Array.isArray(backup.relationships.relationships)
    || !backup.relationships.relationships.every(validRelationship)) {
    throw new Error("備份中的好友資料格式不正確。");
  }
  if (!Array.isArray(backup.operations) || !backup.operations.every(validOperation)) {
    throw new Error("備份中的操作紀錄格式不正確。");
  }
  return createBackup(backup.relationships, backup.operations, backup.exported_at);
}
