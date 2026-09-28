import { encryptPHI, decryptPHI } from '../src/lib/encryption';
import { auditLogger } from '../src/lib/audit';

console.log('--- Running HIPAA Encryption & Audit Logging Verification ---');

// A throwaway key so this script runs without a real HIPAA_MASTER_KEY.
// Never reuse a value like this outside a test.
const TEST_MASTER_KEY = 'a'.repeat(64);

// 1. Test Envelope Encryption
// Fixture data only. Do not put real or realistic patient data in this repo.
const phiData = 'Example: name REDACTED, dob 19XX-01-01, note lorem ipsum';
console.log('Original plaintext:', phiData);

const encrypted = encryptPHI(phiData, TEST_MASTER_KEY);
console.log('Encrypted Envelope generated successfully:', {
  ciphertextLength: encrypted.ciphertext.length,
  encryptedDEKLength: encrypted.encryptedDEK.length,
  iv: encrypted.iv,
});

const decrypted = decryptPHI(encrypted, TEST_MASTER_KEY);
console.log('Decrypted plaintext:', decrypted);

if (decrypted !== phiData) {
  console.error('ERROR: Decrypted PHI does not match original!');
  process.exit(1);
}
console.log('Encryption & Decryption test PASSED.');

// 2. Test SHA-256 Hash-Chained Audit Logging
console.log('\nTesting Audit Log Hash Chaining...');
auditLogger.log('Dr. Smith', 'PHI_ACCESS', 'patient-123', { reason: 'Annual checkup' });
auditLogger.log('Dr. Smith', 'PHI_UPDATE', 'patient-123', { field: 'medication' });
auditLogger.log('Nurse Jackie', 'PHI_READ', 'patient-456', { reason: 'Vitals intake' });

const logs = auditLogger.getLogs();
console.log(`Recorded ${logs.length} audit logs.`);
logs.forEach((log, index) => {
  console.log(`[${index}] Action: ${log.action} | Actor: ${log.actor} | Hash: ${log.hash.substring(0, 12)}... | PrevHash: ${log.previousHash.substring(0, 12)}...`);
});

const isValidInitial = auditLogger.verifyChain();
console.log('Audit chain verification status:', isValidInitial ? 'VALID' : 'INVALID');

if (!isValidInitial) {
  console.error('ERROR: Initial audit chain validation failed!');
  process.exit(1);
}

// 3. Test Tamper Detection
console.log('\nTesting Tamper Detection...');
// Tamper with log[1] details
(logs[1] as unknown as { details?: Record<string, unknown> }).details = { field: 'unauthorized_tampering' };

const isValidTampered = auditLogger.verifyChain();
console.log('Audit chain verification after tampering:', isValidTampered ? 'VALID (FAILED TEST)' : 'INVALID (CORRECTLY DETECTED)');

if (isValidTampered) {
  console.error('ERROR: Tamper detection failed to catch modified audit log!');
  process.exit(1);
}

// 4. Test that encryption fails closed rather than using a fallback key
console.log('\nTesting fail-closed key handling...');

const previousMasterKey = process.env.HIPAA_MASTER_KEY;
delete process.env.HIPAA_MASTER_KEY;
try {
  encryptPHI('should never be encrypted');
  console.error('ERROR: encryptPHI succeeded with no master key — a fallback key is in use!');
  process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('HIPAA_MASTER_KEY is not set')) {
    console.error('ERROR: unexpected failure mode:', message);
    process.exit(1);
  }
  console.log('Refused to encrypt with no master key: PASSED');
}

try {
  encryptPHI('should never be encrypted', 'abc123');
  console.error('ERROR: encryptPHI accepted a malformed key!');
  process.exit(1);
} catch (error) {
  console.log('Rejected malformed master key: PASSED');
}

if (previousMasterKey === undefined) {
  delete process.env.HIPAA_MASTER_KEY;
} else {
  process.env.HIPAA_MASTER_KEY = previousMasterKey;
}

console.log('\nAll HIPAA Audit Logging & Encryption verifications PASSED successfully!');
