/**
 * Full JSON backup and restore.
 *
 * The CSV is for other tools; this is the real backup. It carries the things a
 * flat table cannot: your rule set, category definitions, confirmed links and
 * import history. Restoring from CSV alone would leave you re-teaching the
 * extension everything it had learned.
 */

import type {
  Category,
  ImportBatch,
  Rule,
  Settings,
  SourceRecord,
  Transaction,
  TransactionLink,
} from '@/types/models';

export const BACKUP_FORMAT = 'expenseplanner-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  profileLabel: string;
  transactions: Transaction[];
  categories: Category[];
  rules: Rule[];
  sources: SourceRecord[];
  links: TransactionLink[];
  batches: ImportBatch[];
  settings: Settings;
}

export function buildBackup(data: Omit<BackupFile, 'format' | 'version' | 'exportedAt'>): string {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ...data,
  };
  return JSON.stringify(file, null, 2);
}

export class BackupParseError extends Error {}

/**
 * Read a backup file, rejecting anything that is not one.
 *
 * Checked rather than trusted: importing an arbitrary JSON file as though it
 * were a backup could otherwise wipe or corrupt a real dataset, and the failure
 * would be discovered long after the file that caused it was forgotten.
 */
export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupParseError('That file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new BackupParseError('That file does not contain a backup.');
  }

  const file = parsed as Partial<BackupFile>;
  if (file.format !== BACKUP_FORMAT) {
    throw new BackupParseError('That is not an expensePlanner backup file.');
  }
  if (typeof file.version !== 'number' || file.version > BACKUP_VERSION) {
    throw new BackupParseError(
      `That backup was written by a newer version of expensePlanner (format ${String(file.version)}).`,
    );
  }
  if (!Array.isArray(file.transactions)) {
    throw new BackupParseError('That backup has no transactions in it.');
  }

  return {
    format: BACKUP_FORMAT,
    version: file.version,
    exportedAt: file.exportedAt ?? '',
    profileLabel: file.profileLabel ?? 'imported',
    transactions: file.transactions,
    categories: file.categories ?? [],
    rules: file.rules ?? [],
    sources: file.sources ?? [],
    links: file.links ?? [],
    batches: file.batches ?? [],
    settings: file.settings as Settings,
  };
}

export function backupFileName(now = new Date()): string {
  return `expenseplanner-backup-${now.toISOString().slice(0, 10)}.json`;
}
