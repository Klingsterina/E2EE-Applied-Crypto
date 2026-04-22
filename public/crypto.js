let ecdhKeyPair = null;
let exportedPublicKey = null;
let sharedSecretBase64 = null;
let sessionKey = null;
let exportedSessionKey = null;

const IDENTITY_KEY_BUNDLE_VERSION = 1;
const IDENTITY_DB_NAME = "e2ee-identity-db";
const IDENTITY_DB_VERSION = 1;
const IDENTITY_STORE_NAME = "identity-store";
const IDENTITY_RECORD_KEY = "default-identity";
const PBKDF2_ITERATIONS = 250000;

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

function resetDerivedSessionState() {
  sharedSecretBase64 = null;
  sessionKey = null;
  exportedSessionKey = null;
}

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

async function getPublicKeyFingerprint(publicKeyBase64 = exportedPublicKey) {
  if (!publicKeyBase64) {
    throw new Error("Public key not available.");
  }

  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    base64ToArrayBuffer(publicKeyBase64),
  );

  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

async function derivePassphraseWrappingKey(passphrase, saltBuffer) {
  if (!passphrase) {
    throw new Error("Passphrase is required.");
  }

  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
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
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await derivePassphraseWrappingKey(passphrase, salt);

  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    wrappingKey,
    new TextEncoder().encode(plaintext),
  );

  return {
    kdf: "PBKDF2",
    iterations: PBKDF2_ITERATIONS,
    saltBase64: arrayBufferToBase64(salt.buffer),
    ivBase64: arrayBufferToBase64(iv.buffer),
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
  const iv = new Uint8Array(base64ToArrayBuffer(encryptedPayload.ivBase64));
  const ciphertextBuffer = base64ToArrayBuffer(
    encryptedPayload.ciphertextBase64,
  );
  const wrappingKey = await derivePassphraseWrappingKey(passphrase, saltBuffer);

  const plaintextBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    wrappingKey,
    ciphertextBuffer,
  );

  return new TextDecoder().decode(plaintextBuffer);
}

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

async function importPeerPublicKey(publicKeyBase64) {
  const rawPeerKey = base64ToArrayBuffer(publicKeyBase64);

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

  sharedSecretBase64 = arrayBufferToBase64(sharedSecretBits);

  return {
    sharedSecretBits,
    sharedSecretBase64,
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

  const salt = new TextEncoder().encode(roomId);
  const info = new TextEncoder().encode("e2ee-chat-session-key");

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
    true,
    ["encrypt", "decrypt"],
  );

  const rawSessionKey = await window.crypto.subtle.exportKey("raw", sessionKey);
  exportedSessionKey = arrayBufferToBase64(rawSessionKey);

  return {
    sessionKey,
    sessionKeyBase64: exportedSessionKey,
  };
}

async function deriveSharedSessionKey(peerPublicKeyBase64, roomId) {
  const { sharedSecretBits } = await deriveSharedSecret(peerPublicKeyBase64);
  return deriveSessionKeyFromSharedSecret(sharedSecretBits, roomId);
}

async function encryptMessage(plaintext) {
  if (!sessionKey) {
    throw new Error("Session key not ready.");
  }

  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encodedMessage = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    sessionKey,
    encodedMessage,
  );

  const ciphertext = arrayBufferToBase64(ciphertextBuffer);
  const ivBase64 = arrayBufferToBase64(iv.buffer);

  return {
    ciphertext,
    iv: ivBase64,
  };
}

async function decryptMessage(ciphertextBase64, ivBase64) {
  if (!sessionKey) {
    throw new Error("Session key not ready.");
  }

  const ciphertextBuffer = base64ToArrayBuffer(ciphertextBase64);
  const ivBuffer = base64ToArrayBuffer(ivBase64);

  const plaintextBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(ivBuffer),
    },
    sessionKey,
    ciphertextBuffer,
  );

  return new TextDecoder().decode(plaintextBuffer);
}

function getECDHKeyPair() {
  return ecdhKeyPair;
}

function getPublicKey() {
  return exportedPublicKey;
}

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
