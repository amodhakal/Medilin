import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  details?: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export class AuditLogManager {
  private logs: AuditLogEntry[] = [];
  private genesisHash: string = '0000000000000000000000000000000000000000000000000000000000000000';

  private calculateHash(entry: Omit<AuditLogEntry, 'hash'>): string {
    const dataToHash = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      details: entry.details || {},
      previousHash: entry.previousHash,
    });
    return crypto.createHash('sha256').update(dataToHash).digest('hex');
  }

  public log(actor: string, action: string, resource: string, details?: Record<string, unknown>): AuditLogEntry {
    const previousHash = this.logs.length > 0 ? this.logs[this.logs.length - 1].hash : this.genesisHash;
    const id = uuidv4();
    const timestamp = new Date().toISOString();

    const partialEntry = {
      id,
      timestamp,
      actor,
      action,
      resource,
      details,
      previousHash,
    };

    const hash = this.calculateHash(partialEntry);
    const entry: AuditLogEntry = {
      ...partialEntry,
      hash,
    };

    this.logs.push(entry);
    return entry;
  }

  public getLogs(): AuditLogEntry[] {
    return [...this.logs];
  }

  public verifyChain(): boolean {
    if (this.logs.length === 0) return true;

    for (let i = 0; i < this.logs.length; i++) {
      const entry = this.logs[i];
      const expectedPreviousHash = i === 0 ? this.genesisHash : this.logs[i - 1].hash;

      if (entry.previousHash !== expectedPreviousHash) {
        return false;
      }

      const { hash, ...partial } = entry;
      const calculatedHash = this.calculateHash(partial);
      if (calculatedHash !== hash) {
        return false;
      }
    }
    return true;
  }
}

export const auditLogger = new AuditLogManager();
