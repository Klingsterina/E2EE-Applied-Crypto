const IDENTITY_KEY_BUNDLE_VERSION = 1;
const IDENTITY_DB_NAME = "e2ee-identity-db";
const IDENTITY_DB_VERSION = 1;
const IDENTITY_STORE_NAME = "identity-store";
const IDENTITY_RECORD_KEY = "default-identity";
const PBKDF2_ITERATIONS = 250000;
const AES_GCM_NONCE_BYTES = 12;
const PBKDF2_SALT_BYTES = 16;
const PUBLIC_KEY_FINGERPRINT_BYTES = 16;
const HKDF_INFO = "e2ee-chat-session-key";
const MAX_PUBLIC_KEY_BASE64_LENGTH = 1_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let ecdhKeyPair = null;
let exportedPublicKey = null;
let sessionKey = null;

// From ArrayBuffer to Base64 and vice versa
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

// Tiny helper to reset derived session state :P
function resetDerivedSessionState() {
  sessionKey = null;
}

// Validating imported identity keys
function normalizeImportedKeyBundle(bundleInput) {
  const bundle =
    typeof bundleInput === "string" ? JSON.parse(bundleInput) : bundleInput;

  if (!bundle || typeof bundle !== "object") {
    throw new Error("Invalid key bundle.");
  }

  if (bundle.type !== "e2ee-identity-key-bundle") {
    throw new Error("Unsupported key bundle type.");
  }

  if (bundle.version !== IDENTITY_KEY_BUNDLE_VERSION) {
    throw new Error("Unsupported key bundle version.");
  }

  if (!bundle.privateKeyJwk || !bundle.publicKeyJwk) {
    throw new Error("Key bundle is missing key material.");
  }

  return bundle;
}

// Functions we need to store and load identity keys (in IndexedDB btw)
function openIdentityDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(
      IDENTITY_DB_NAME,
      IDENTITY_DB_VERSION,
    );

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(IDENTITY_STORE_NAME)) {
        db.createObjectStore(IDENTITY_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistIdentityKeyPair(keyPair, publicKeyBase64) {
  const db = await openIdentityDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(IDENTITY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(IDENTITY_STORE_NAME);

    store.put({
      id: IDENTITY_RECORD_KEY,
      keyPair,
      publicKeyBase64,
      storedAt: new Date().toISOString(),
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  db.close();
}

async function loadPersistedIdentityKeyPair() {
  const db = await openIdentityDb();

  const record = await new Promise((resolve, reject) => {
    const transaction = db.transaction(IDENTITY_STORE_NAME, "readonly");
    const store = transaction.objectStore(IDENTITY_STORE_NAME);
    const request = store.get(IDENTITY_RECORD_KEY);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });

  db.close();

  if (!record?.keyPair?.privateKey || !record?.keyPair?.publicKey) {
    return null;
  }

  ecdhKeyPair = record.keyPair;
  exportedPublicKey = record.publicKeyBase64 || null;

  if (!exportedPublicKey) {
    const rawPublicKey = await window.crypto.subtle.exportKey(
      "raw",
      ecdhKeyPair.publicKey,
    );
    exportedPublicKey = arrayBufferToBase64(rawPublicKey);
  }

  resetDerivedSessionState();

  return {
    publicKey: exportedPublicKey,
    keyPair: ecdhKeyPair,
  };
}

async function clearPersistedIdentityKeyPair() {
  const db = await openIdentityDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(IDENTITY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(IDENTITY_STORE_NAME);
    const request = store.delete(IDENTITY_RECORD_KEY);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  db.close();
}

// Utils to generate key fingerprints
async function getPublicKeyFingerprint(publicKeyBase64 = exportedPublicKey) {
  if (!publicKeyBase64) {
    throw new Error("Public key not available.");
  }

  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    base64ToArrayBuffer(publicKeyBase64),
  );

  return [...new Uint8Array(digest)]
    .slice(0, PUBLIC_KEY_FINGERPRINT_BYTES)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

// Functions to encrypt and decrypt key backups (needs the passphrase)
async function derivePassphraseWrappingKey(passphrase, saltBuffer) {
  if (!passphrase) {
    throw new Error("Passphrase is required.");
  }

  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptTextWithPassphrase(plaintext, passphrase) {
  const salt = window.crypto.getRandomValues(
    new Uint8Array(PBKDF2_SALT_BYTES),
  );
  const nonce = window.crypto.getRandomValues(
    new Uint8Array(AES_GCM_NONCE_BYTES),
  );
  const wrappingKey = await derivePassphraseWrappingKey(passphrase, salt);

  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
    },
    wrappingKey,
    textEncoder.encode(plaintext),
  );

  return {
    kdf: "PBKDF2",
    iterations: PBKDF2_ITERATIONS,
    saltBase64: arrayBufferToBase64(salt.buffer),
    ivBase64: arrayBufferToBase64(nonce.buffer),
    ciphertextBase64: arrayBufferToBase64(ciphertext),
  };
}

async function decryptTextWithPassphrase(encryptedPayload, passphrase) {
  if (
    !encryptedPayload?.saltBase64 ||
    !encryptedPayload?.ivBase64 ||
    !encryptedPayload?.ciphertextBase64
  ) {
    throw new Error("Encrypted key bundle payload is invalid.");
  }

  const saltBuffer = base64ToArrayBuffer(encryptedPayload.saltBase64);
  const nonce = new Uint8Array(base64ToArrayBuffer(encryptedPayload.ivBase64));
  const ciphertextBuffer = base64ToArrayBuffer(
    encryptedPayload.ciphertextBase64,
  );
  const wrappingKey = await derivePassphraseWrappingKey(passphrase, saltBuffer);

  const plaintextBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce,
    },
    wrappingKey,
    ciphertextBuffer,
  );

  return textDecoder.decode(plaintextBuffer);
}

// Functions to create, import, and export identity key pairs
async function generateECDHKeyPair() {
  ecdhKeyPair = await window.crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveBits"],
  );

  const rawPublicKey = await window.crypto.subtle.exportKey(
    "raw",
    ecdhKeyPair.publicKey,
  );

  exportedPublicKey = arrayBufferToBase64(rawPublicKey);
  resetDerivedSessionState();
  await persistIdentityKeyPair(ecdhKeyPair, exportedPublicKey);

  return {
    publicKey: exportedPublicKey,
    keyPair: ecdhKeyPair,
  };
}

async function exportIdentityKeyBundle() {
  if (!ecdhKeyPair?.privateKey || !ecdhKeyPair?.publicKey) {
    throw new Error("ECDH key pair not ready.");
  }

  const privateKeyJwk = await window.crypto.subtle.exportKey(
    "jwk",
    ecdhKeyPair.privateKey,
  );

  const publicKeyJwk = await window.crypto.subtle.exportKey(
    "jwk",
    ecdhKeyPair.publicKey,
  );

  return {
    type: "e2ee-identity-key-bundle",
    version: IDENTITY_KEY_BUNDLE_VERSION,
    algorithm: "ECDH",
    namedCurve: "P-256",
    createdAt: new Date().toISOString(),
    publicKeyBase64: exportedPublicKey,
    publicKeyJwk,
    privateKeyJwk,
  };
}

async function importIdentityKeyBundle(bundleInput) {
  const bundle = normalizeImportedKeyBundle(bundleInput);

  const importedPrivateKey = await window.crypto.subtle.importKey(
    "jwk",
    bundle.privateKeyJwk,
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveBits"],
  );

  const importedPublicKey = await window.crypto.subtle.importKey(
    "jwk",
    bundle.publicKeyJwk,
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    [],
  );

  ecdhKeyPair = {
    privateKey: importedPrivateKey,
    publicKey: importedPublicKey,
  };

  const rawPublicKey = await window.crypto.subtle.exportKey(
    "raw",
    importedPublicKey,
  );

  exportedPublicKey = arrayBufferToBase64(rawPublicKey);
  resetDerivedSessionState();
  await persistIdentityKeyPair(ecdhKeyPair, exportedPublicKey);

  return {
    publicKey: exportedPublicKey,
    keyPair: ecdhKeyPair,
  };
}

async function exportIdentityKeyBundleJson() {
  const bundle = await exportIdentityKeyBundle();
  return JSON.stringify(bundle, null, 2);
}

async function exportEncryptedIdentityKeyBundle(passphrase) {
  const bundle = await exportIdentityKeyBundle();
  const encryptedPrivateBundle = await encryptTextWithPassphrase(
    JSON.stringify(bundle),
    passphrase,
  );

  return {
    type: "e2ee-encrypted-identity-key-bundle",
    version: IDENTITY_KEY_BUNDLE_VERSION,
    algorithm: "ECDH",
    namedCurve: "P-256",
    createdAt: new Date().toISOString(),
    publicKeyBase64: bundle.publicKeyBase64,
    encryptedPrivateBundle,
  };
}

async function exportEncryptedIdentityKeyBundleJson(passphrase) {
  const bundle = await exportEncryptedIdentityKeyBundle(passphrase);
  return JSON.stringify(bundle, null, 2);
}

async function importEncryptedIdentityKeyBundle(bundleInput, passphrase) {
  const encryptedBundle =
    typeof bundleInput === "string" ? JSON.parse(bundleInput) : bundleInput;

  if (!encryptedBundle || typeof encryptedBundle !== "object") {
    throw new Error("Invalid encrypted key bundle.");
  }

  if (encryptedBundle.type !== "e2ee-encrypted-identity-key-bundle") {
    throw new Error("Unsupported encrypted key bundle type.");
  }

  if (encryptedBundle.version !== IDENTITY_KEY_BUNDLE_VERSION) {
    throw new Error("Unsupported encrypted key bundle version.");
  }

  const decryptedBundleJson = await decryptTextWithPassphrase(
    encryptedBundle.encryptedPrivateBundle,
    passphrase,
  );

  return importIdentityKeyBundle(decryptedBundleJson);
}

// Key exchange and deriving a session key (using ECDH and HKDF)
async function importPeerPublicKey(publicKeyBase64) {
  if (
    typeof publicKeyBase64 !== "string" ||
    !publicKeyBase64.trim() ||
    publicKeyBase64.length > MAX_PUBLIC_KEY_BASE64_LENGTH
  ) {
    throw new Error("Peer public key is invalid.");
  }

  const rawPeerKey = base64ToArrayBuffer(publicKeyBase64.trim());

  return window.crypto.subtle.importKey(
    "raw",
    rawPeerKey,
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    [],
  );
}

async function deriveSharedSecret(peerPublicKeyBase64) {
  if (!ecdhKeyPair?.privateKey) {
    throw new Error("Local ECDH key pair not ready.");
  }

  const peerPublicKey = await importPeerPublicKey(peerPublicKeyBase64);

  const sharedSecretBits = await window.crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: peerPublicKey,
    },
    ecdhKeyPair.privateKey,
    256,
  );

  return {
    sharedSecretBits,
  };
}

async function deriveSessionKeyFromSharedSecret(sharedSecretBits, roomId) {
  const hkdfKeyMaterial = await window.crypto.subtle.importKey(
    "raw",
    sharedSecretBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  const salt = textEncoder.encode(roomId);
  const info = textEncoder.encode(HKDF_INFO);

  sessionKey = await window.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    hkdfKeyMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    sessionKey,
  };
}

async function deriveSharedSessionKey(peerPublicKeyBase64, roomId) {
  const { sharedSecretBits } = await deriveSharedSecret(peerPublicKeyBase64);
  return deriveSessionKeyFromSharedSecret(sharedSecretBits, roomId);
}

// Encrypting and decrypting chat messages with AES-GCM
async function encryptMessage(plaintext) {
  if (!sessionKey) {
    throw new Error("Session key not ready.");
  }

  const nonce = window.crypto.getRandomValues(
    new Uint8Array(AES_GCM_NONCE_BYTES),
  );
  const encodedMessage = textEncoder.encode(plaintext);

  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
    },
    sessionKey,
    encodedMessage,
  );

  return {
    ciphertext: arrayBufferToBase64(ciphertextBuffer),
    nonce: arrayBufferToBase64(nonce.buffer),
  };
}

async function decryptMessage(ciphertextBase64, nonceBase64) {
  if (!sessionKey) {
    throw new Error("Session key not ready.");
  }

  const ciphertextBuffer = base64ToArrayBuffer(ciphertextBase64);
  const nonceBuffer = base64ToArrayBuffer(nonceBase64);

  const plaintextBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(nonceBuffer),
    },
    sessionKey,
    ciphertextBuffer,
  );

  return textDecoder.decode(plaintextBuffer);
}

// Getters for the current crypto state
function getECDHKeyPair() {
  return ecdhKeyPair;
}

function getPublicKey() {
  return exportedPublicKey;
}

// this exposes the crypto functions to the rest of the app
window.e2eeCrypto = {
  generateECDHKeyPair,
  loadPersistedIdentityKeyPair,
  clearPersistedIdentityKeyPair,
  exportEncryptedIdentityKeyBundle,
  exportEncryptedIdentityKeyBundleJson,
  importEncryptedIdentityKeyBundle,
  exportIdentityKeyBundle,
  exportIdentityKeyBundleJson,
  importIdentityKeyBundle,
  importPeerPublicKey,
  deriveSharedSecret,
  deriveSessionKeyFromSharedSecret,
  deriveSharedSessionKey,
  encryptMessage,
  decryptMessage,
  getECDHKeyPair,
  getPublicKey,
  getPublicKeyFingerprint,
};
