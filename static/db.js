const DB_NAME = "discord-friend-manager";
const DB_VERSION = 1;
const STORE_NAME = "data";

let databasePromise;

function database() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("本機資料庫被其他分頁占用。"));
    });
  }
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readLocal(key, fallback = null) {
  const db = await database();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const value = await requestResult(transaction.objectStore(STORE_NAME).get(key));
  return value ?? fallback;
}

export async function writeLocal(key, value) {
  const db = await database();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  await requestResult(transaction.objectStore(STORE_NAME).put(value, key));
}

export async function deleteLocal(key) {
  const db = await database();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  await requestResult(transaction.objectStore(STORE_NAME).delete(key));
}
