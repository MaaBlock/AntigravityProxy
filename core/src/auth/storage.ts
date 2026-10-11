import { join } from "path";
import { type AntigravityAccount, type SelectionStrategy } from "./types";

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || (require("fs").existsSync(join(process.cwd(), "..", "data", "antigravity-accounts.json")) ? join(process.cwd(), "..", "data", "antigravity-accounts.json") : join(process.cwd(), "antigravity-accounts.json"));

interface StorageFormat {
    accounts: AntigravityAccount[];
    strategy?: SelectionStrategy;
}

// Account health, cooldown and capability updates can arrive concurrently.
// Serialize complete JSON snapshots so overlapping writes cannot corrupt the
// credentials file or leave trailing bytes from another update.
let saveQueue: Promise<void> = Promise.resolve();

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(ACCOUNTS_FILE);
    if (await file.exists()) {
      const data = await file.json();
      if (Array.isArray(data)) {
          // Migration from old format
          return { accounts: data, strategy: 'hybrid' };
      }
      return data;
    }
  } catch (e) {
    console.error("Failed to load accounts:", e);
  }
  return { accounts: [] };
}

// Kept for backward compatibility but deprecated
export async function loadAccounts(): Promise<AntigravityAccount[]> {
    return (await loadConfig()).accounts;
}

export async function saveConfig(config: StorageFormat): Promise<void> {
  const snapshot = JSON.stringify(config, null, 2);
  const write = saveQueue.then(async () => {
    await Bun.write(ACCOUNTS_FILE, snapshot);
  });
  saveQueue = write.catch(() => {});

  try {
    await write;
  } catch (e) {
    console.error("Failed to save accounts:", e);
  }
}
