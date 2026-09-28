import { encryptPHI, decryptPHI } from '../src/lib/encryption';
import {
  AuditDetailsError,
  GENESIS_HASH,
  assertAuditDetails,
  calculateEntryHash,
  verifyChain,
  type AuditLogEntry,
} from '../src/lib/audit/store';
import { InMemoryAuditLogStore } from '../src/lib/audit/memory-store';

/**
 * The HIPAA checks, as a script rather than a test file, because CI runs this and
 * it is meant to be readable end to end by someone who has to satisfy an auditor.
 *
 * It imports the chain and the in-memory store directly rather than going
 * through `@/lib/audit`. The facade reaches `@/lib/storage` to decide between the
 * in-memory and the durable chain, and that module is marked `server-only` --
 * correctly, since it holds DATABASE_URL. `server-only` throws outside a React
 * Server Component, which is the point in the app and a nuisance in a script.
 *
 * So the split is: this file verifies the two properties that are about the
 * cryptography and the chain itself, and the unit tests verify the wiring --
 * that the booking path and the record read go through the facade, and that a
 * trail which cannot be written fails the access. `bun test` runs both, and CI
 * runs it.
 *
 * The durable chain and the ciphertext at rest are covered in the unit tests
 * against a `SqlClient` double, because there is no database in this repository
 * and no credentials in CI.
 */

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

// Two records of the same thing must not produce the same envelope. A reused DEK
// means one recovered key opens every record the master key has ever wrapped.
if (encryptPHI(phiData, TEST_MASTER_KEY).encryptedDEK === encrypted.encryptedDEK) {
  console.error('ERROR: Two encryptions produced the same wrapped data key!');
  process.exit(1);
}

if (JSON.stringify(encrypted).includes('lorem ipsum')) {
  console.error('ERROR: The envelope contains the plaintext it should be hiding!');
  process.exit(1);
}
console.log('Encryption & Decryption test PASSED.');

// 2. Test SHA-256 Hash-Chained Audit Logging
console.log('\nTesting Audit Log Hash Chaining...');

const trail = new InMemoryAuditLogStore();
const recorded: AuditLogEntry[] = [
  trail.write({
    id: 'fixture-1',
    timestamp: '2026-01-01T09:00:00.000Z',
    actor: 'patient:web',
    action: 'APPOINTMENT_CREATED',
    resource: 'appointment:fixture-1',
    details: { reason: 'intake', status: 'scheduled' },
  }),
  trail.write({
    id: 'fixture-2',
    timestamp: '2026-01-01T09:05:00.000Z',
    actor: 'internal-api',
    action: 'PHI_READ',
    resource: 'appointment:fixture-1',
    details: { status: 'scheduled' },
  }),
  trail.write({
    id: 'fixture-3',
    timestamp: '2026-01-01T09:10:00.000Z',
    actor: 'link-bearer',
    action: 'APPOINTMENT_CANCELLED',
    resource: 'appointment:fixture-1',
    details: { reason: 'status_change', status: 'cancelled' },
  }),
];

console.log(`Recorded ${recorded.length} audit logs.`);
recorded.forEach((log, index) => {
  console.log(`[${index}] Action: ${log.action} | Actor: ${log.actor} | Hash: ${log.hash.substring(0, 12)}... | PrevHash: ${log.previousHash.substring(0, 12)}...`);
});

if (recorded[0].previousHash !== GENESIS_HASH) {
  console.error('ERROR: The first entry does not chain to genesis!');
  process.exit(1);
}
if (recorded[1].previousHash !== recorded[0].hash || recorded[2].previousHash !== recorded[1].hash) {
  console.error('ERROR: Entries are not linked to the entry before them!');
  process.exit(1);
}

const isValidInitial = verifyChain(recorded);
console.log('Audit chain verification status:', isValidInitial ? 'VALID' : 'INVALID');

if (!isValidInitial) {
  console.error('ERROR: Initial audit chain validation failed!');
  process.exit(1);
}

// 3. Test that the trail cannot carry PHI
console.log('\nTesting that audit details are a closed set...');

try {
  assertAuditDetails({ additionalInfo: 'chest pain since Tuesday' });
  console.error('ERROR: an audit entry could carry a field outside the closed set!');
  process.exit(1);
} catch (error) {
  if (!(error instanceof AuditDetailsError)) {
    console.error('ERROR: unexpected failure mode:', error);
    process.exit(1);
  }
  if (error.message.includes('chest pain')) {
    console.error('ERROR: the refusal quoted the value it refused to store!');
    process.exit(1);
  }
  // A trail cannot be redacted and cannot be dropped, so a symptom description
  // written into one would be permanent.
  console.log('Refused an unrecognised details key, without quoting the value: PASSED');
}

// 4. Test Tamper Detection
console.log('\nTesting Tamper Detection...');

// Reaching the managed array directly, the way an attacker with write access to
// the log would. `read()` hands back copies now, which is right for a caller and
// useless for demonstrating that a modified entry is detectable.
const entries = (trail as unknown as { entries: AuditLogEntry[] }).entries;
entries[1].details = { reason: 'internal_api' };

const isValidTampered = verifyChain(entries);
console.log('Audit chain verification after tampering:', isValidTampered ? 'VALID (FAILED TEST)' : 'INVALID (CORRECTLY DETECTED)');

if (isValidTampered) {
  console.error('ERROR: Tamper detection failed to catch modified audit log!');
  process.exit(1);
}

// 5. Test that a removed entry is detected
console.log('\nTesting that a removed entry is detected...');

// The middle entry is gone and the third is left pointing at it, which is the
// shape an audit log takes when a row is deleted. (Recomputing the chain from
// there on would be a *valid* chain -- see the note in verifyChain about what a
// hash chain does and does not prove.)
if (verifyChain([entries[0], entries[2]])) {
  console.error('ERROR: A chain with a removed entry verified!');
  process.exit(1);
}
console.log('Detected a removed entry: PASSED');

// 6. Test that the hash does not depend on the order the keys arrived in
console.log('\nTesting hash stability across a storage round trip...');

// A jsonb column does not preserve key order. A hash computed over an object's
// own key order would disagree with itself the moment the trail was read back.
const base = {
  id: 'fixture-1',
  timestamp: '2026-01-01T09:00:00.000Z',
  actor: 'patient:web',
  action: 'APPOINTMENT_CREATED' as const,
  resource: 'appointment:fixture-1',
  previousHash: GENESIS_HASH,
};

const ordered = calculateEntryHash({ ...base, details: { reason: 'intake', status: 'scheduled' } });
const reordered = calculateEntryHash({ ...base, details: { status: 'scheduled', reason: 'intake' } });

if (ordered !== reordered) {
  console.error('ERROR: The entry hash depends on details key order!');
  process.exit(1);
}
console.log('Hash is independent of details key order: PASSED');

// 7. Test that encryption fails closed rather than using a fallback key
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
} catch {
  console.log('Rejected malformed master key: PASSED');
}

if (previousMasterKey === undefined) {
  delete process.env.HIPAA_MASTER_KEY;
} else {
  process.env.HIPAA_MASTER_KEY = previousMasterKey;
}

console.log('\nAll HIPAA Audit Logging & Encryption verifications PASSED successfully!');
