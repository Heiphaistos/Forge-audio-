import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Data folder (sessions + one library per user) and accounts file.
 * Accounts: $ACCOUNTS_FILE, else <data>/accounts.json, seeded on first start from server/accounts.json.
 */
export function resolvePaths() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '../../data'));
  fs.mkdirSync(dataDir, { recursive: true });
  let accountsFile = process.env.ACCOUNTS_FILE;
  if (!accountsFile) {
    accountsFile = path.join(dataDir, 'accounts.json');
    const seed = path.resolve(here, '../accounts.json');
    if (!fs.existsSync(accountsFile) && fs.existsSync(seed)) fs.copyFileSync(seed, accountsFile);
  }
  return { dataDir, accountsFile };
}
