import * as crypto from 'crypto';

export const ALGORITHM = 'aes-256-gcm';
export const KEY_LENGTH = 32; // 256 bits
export const IV_LENGTH = 12; // 96 bits for GCM recommended

/**
 * Resolve the key-encryption key.
 *
 * There is deliberately no fallback. The previous implementation derived a
 * key with `scryptSync('medilin-hipaa-default-kek-secret', 'salt', ...)` when
 * HIPAA_MASTER_KEY was unset, which meant a secret committed to a public
 * repository silently protected every record whenever the real variable was
 * missing — and HIPAA_MASTER_KEY was not listed in .env.example, so the
 * fallback was the expected path. Absence is now an error.
 */
export function getMasterKey(masterKeyHex?: string): Buffer {
  const hex = masterKeyHex ?? process.env.HIPAA_MASTER_KEY;

  if (!hex) {
    throw new Error(
      'HIPAA_MASTER_KEY is not set. Refusing to encrypt: a fallback key would ' +
        'mean the key protecting patient records is not a secret. Generate one ' +
        'with `openssl rand -hex 32`.',
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `HIPAA_MASTER_KEY must be exactly 64 hex characters (32 bytes) for ${ALGORITHM}.`,
    );
  }

  return Buffer.from(hex, 'hex');
}

export interface EncryptedEnvelope {
  ciphertext: string;
  encryptedDEK: string;
  iv: string;
  dekIv: string;
  authTag: string;
  dekAuthTag: string;
}

export function encryptPHI(plaintext: string, masterKeyHex?: string): EncryptedEnvelope {
  const masterKey = getMasterKey(masterKeyHex);

  // 1. Generate unique DEK
  const dek = crypto.randomBytes(KEY_LENGTH);

  // 2. Encrypt plaintext (PHI) using DEK
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // 3. Encrypt DEK using Master Key (KEK)
  const dekIv = crypto.randomBytes(IV_LENGTH);
  const dekCipher = crypto.createCipheriv(ALGORITHM, masterKey, dekIv);
  let encryptedDEK = dekCipher.update(dek);
  encryptedDEK = Buffer.concat([encryptedDEK, dekCipher.final()]);
  const dekAuthTag = dekCipher.getAuthTag().toString('hex');

  return {
    ciphertext,
    encryptedDEK: encryptedDEK.toString('hex'),
    iv: iv.toString('hex'),
    dekIv: dekIv.toString('hex'),
    authTag,
    dekAuthTag,
  };
}

export function decryptPHI(envelope: EncryptedEnvelope, masterKeyHex?: string): string {
  const masterKey = getMasterKey(masterKeyHex);

  // 1. Decrypt DEK using Master Key
  const dekIvBuf = Buffer.from(envelope.dekIv, 'hex');
  const dekAuthTagBuf = Buffer.from(envelope.dekAuthTag, 'hex');
  const encryptedDEKBuf = Buffer.from(envelope.encryptedDEK, 'hex');

  const dekDecipher = crypto.createDecipheriv(ALGORITHM, masterKey, dekIvBuf);
  dekDecipher.setAuthTag(dekAuthTagBuf);
  let dek = dekDecipher.update(encryptedDEKBuf);
  dek = Buffer.concat([dek, dekDecipher.final()]);

  // 2. Decrypt ciphertext using DEK
  const ivBuf = Buffer.from(envelope.iv, 'hex');
  const authTagBuf = Buffer.from(envelope.authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, dek, ivBuf);
  decipher.setAuthTag(authTagBuf);
  let plaintext = decipher.update(envelope.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}
