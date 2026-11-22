// Simulate an insecure context (plain HTTP on mobile LAN IP) where crypto.subtle is undefined
const originalSubtle = globalThis.crypto.subtle;
delete globalThis.crypto.subtle;
Object.defineProperty(globalThis.crypto, 'subtle', {
  get() { return undefined; },
  configurable: true
});

console.log('Is crypto.subtle undefined?:', globalThis.crypto.subtle === undefined);

// Now run the full crypto tests using lib/crypto.ts
const cryptoEngine = await import('../lib/crypto.ts');

async function run() {
  console.log('--- Testing lib/crypto.ts in simulated Insecure Context (Mobile HTTP LAN) ---');

  // 1. generateSalt
  const salt = cryptoEngine.generateSalt();
  if (!salt) throw new Error('generateSalt failed');
  console.log('  ✓ [PASS] generateSalt works in insecure context');

  // 2. deriveKeysFromPassword
  const { kek, authToken } = await cryptoEngine.deriveKeysFromPassword('Password123!', salt);
  if (!kek || !authToken) throw new Error('deriveKeysFromPassword failed');
  console.log('  ✓ [PASS] deriveKeysFromPassword works in insecure context');

  // 3. createAndWrapRoomKey
  const roomId = '5ac723f4-60b8-4426-a848-62e9780f712d';
  const { rmk, wrappedKey, wrappedIv } = await cryptoEngine.createAndWrapRoomKey(kek, roomId);
  if (!rmk || !wrappedKey || !wrappedIv) throw new Error('createAndWrapRoomKey failed');
  console.log('  ✓ [PASS] createAndWrapRoomKey works in insecure context');

  // 4. unwrapRoomKey
  const restoredRmk = await cryptoEngine.unwrapRoomKey(kek, wrappedKey, wrappedIv, roomId);
  if (!restoredRmk) throw new Error('unwrapRoomKey failed');
  console.log('  ✓ [PASS] unwrapRoomKey works in insecure context');

  // 5. encryptMessagePayload & decryptMessagePayload
  const payload = { text: 'Hello from Mobile Phone over plain HTTP!', fileNames: ['notes.pdf'] };
  const { encryptedContent, iv } = await cryptoEngine.encryptMessagePayload(restoredRmk, roomId, 'msg-1', payload);
  const decrypted = await cryptoEngine.decryptMessagePayload(restoredRmk, roomId, 'msg-1', encryptedContent, iv);
  if (decrypted.text !== payload.text) throw new Error('Decrypted text mismatch');
  console.log('  ✓ [PASS] encryptMessagePayload & decryptMessagePayload works in insecure context');

  // 6. encryptMediaBlob & decryptMediaBlob
  const rawData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
  const blob = await cryptoEngine.encryptMediaBlob(restoredRmk, roomId, 'msg-1', 'raw-0', rawData);
  const blobBuffer = await blob.arrayBuffer();
  const decryptedData = await cryptoEngine.decryptMediaBlob(restoredRmk, roomId, 'msg-1', 'raw-0', blobBuffer);
  if (Buffer.from(decryptedData).toString('hex') !== Buffer.from(rawData).toString('hex')) {
    throw new Error('Decrypted media blob mismatch');
  }
  console.log('  ✓ [PASS] encryptMediaBlob & decryptMediaBlob works in insecure context');

  console.log('ALL INSECURE CONTEXT TESTS PASSED! Mobile HTTP over LAN is 100% operational!');
}

run().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
