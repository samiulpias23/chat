import {
  generateSalt,
  deriveKeysFromPassword,
  createAndWrapRoomKey,
  unwrapRoomKey,
  encryptMessagePayload,
  decryptMessagePayload,
  encryptMediaBlob,
  decryptMediaBlob
} from '../lib/crypto.ts';

console.log('--- Testing Web Crypto E2EE Engine ---');

let passed = 0;
let total = 0;
function assert(condition, message) {
  total++;
  if (condition) {
    console.log(`  ✓ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✗ [FAIL] ${message}`);
  }
}

async function runCryptoTests() {
  const roomId = '11111111-2222-3333-4444-555555555555';
  const password = 'CorrectHorseBatteryStaple#99';
  const wrongPassword = 'WrongPassword#00';

  // 1. Salt & Key Derivation
  const salt = generateSalt();
  const { kek, authToken } = await deriveKeysFromPassword(password, salt);
  assert(typeof salt === 'string' && salt.length > 20, 'generateSalt produces valid base64 salt');
  assert(!!kek && typeof authToken === 'string', 'deriveKeysFromPassword derives KEK and client authToken');

  // 2. Wrap & Unwrap
  const { rmk, wrappedKey, wrappedIv } = await createAndWrapRoomKey(kek, roomId);
  assert(!!rmk && typeof wrappedKey === 'string' && typeof wrappedIv === 'string', 'createAndWrapRoomKey wraps RMK');

  const unwrappedRmk = await unwrapRoomKey(kek, wrappedKey, wrappedIv, roomId);
  assert(!!unwrappedRmk, 'unwrapRoomKey successfully restores RMK with valid KEK and matching roomId');

  // 3. Wrong Password / Wrong KEK Rejection
  const { kek: wrongKek } = await deriveKeysFromPassword(wrongPassword, salt);
  let wrongKeyError = false;
  try {
    await unwrapRoomKey(wrongKek, wrappedKey, wrappedIv, roomId);
  } catch {
    wrongKeyError = true;
  }
  assert(wrongKeyError, 'unwrapRoomKey strictly rejects decryption with incorrect password/KEK');

  // 4. AAD Mismatch Rejection (tamper resistance)
  let aadError = false;
  try {
    await unwrapRoomKey(kek, wrappedKey, wrappedIv, '99999999-9999-9999-9999-999999999999');
  } catch {
    aadError = true;
  }
  assert(aadError, 'unwrapRoomKey strictly rejects decryption when roomId AAD mismatches');

  // 5. Message Payload Encryption & Decryption
  const messageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const payload = {
    text: 'Zero-knowledge encrypted secret message!',
    fileNames: ['photo.jpg'],
    gifUrl: 'https://media.giphy.com/media/test/giphy.gif'
  };

  const { encryptedContent, iv } = await encryptMessagePayload(rmk, roomId, messageId, payload);
  assert(typeof encryptedContent === 'string' && typeof iv === 'string', 'encryptMessagePayload produces ciphertext and IV');

  const decryptedPayload = await decryptMessagePayload(unwrappedRmk, roomId, messageId, encryptedContent, iv);
  assert(
    decryptedPayload.text === payload.text &&
    decryptedPayload.fileNames[0] === 'photo.jpg' &&
    decryptedPayload.gifUrl === payload.gifUrl,
    'decryptMessagePayload successfully recovers original text, fileNames, and gifUrl'
  );

  // 6. Binary Blob Media Encryption & Decryption
  const dummyRaw = new TextEncoder().encode('RAW LOSSLESS 4K IMAGE BYTES (ORIGINAL QUALITY)').buffer;
  const encryptedBlob = await encryptMediaBlob(rmk, roomId, messageId, 'raw-0', dummyRaw);
  const blobBuffer = await encryptedBlob.arrayBuffer();

  const decryptedBuffer = await decryptMediaBlob(unwrappedRmk, roomId, messageId, 'raw-0', blobBuffer);
  const recoveredText = new TextDecoder().decode(decryptedBuffer);
  assert(
    recoveredText === 'RAW LOSSLESS 4K IMAGE BYTES (ORIGINAL QUALITY)',
    'encryptMediaBlob / decryptMediaBlob preserves lossless binary byte fidelity'
  );

  // 7. Binary Blob AAD Tamper Rejection
  let blobTamperError = false;
  try {
    // Decrypt with wrong slot (e.g. 'thumb-0' instead of 'raw-0')
    await decryptMediaBlob(unwrappedRmk, roomId, messageId, 'thumb-0', blobBuffer);
  } catch {
    blobTamperError = true;
  }
  assert(blobTamperError, 'decryptMediaBlob strictly rejects blob if slot AAD was tampered with');

  console.log(`\nCrypto Tests Finished: ${passed}/${total} passed!`);
  if (passed !== total) process.exit(1);
}

runCryptoTests().catch(err => {
  console.error('Crypto test execution failed:', err);
  process.exit(1);
});
