let ecdhKeyPair = null;
let exportedPublicKey = null;
let sharedSecretBase64 = null;
let sessionKey = null;
let exportedSessionKey = null;

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

  console.log("ECDH key pair generated");
  console.log("Public key:", exportedPublicKey);

  return {
    publicKey: exportedPublicKey,
    keyPair: ecdhKeyPair,
  };
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

  console.log("Shared secret derived");
  console.log("Shared secret:", sharedSecretBase64);

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

  console.log("Session key derived with HKDF");
  console.log("Session key:", exportedSessionKey);

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

  console.log("Message encrypted with AES-GCM");
  console.log("Generated IV:", ivBase64);
  console.log("Ciphertext:", ciphertext);

  return {
    ciphertext,
    iv: ivBase64,
  };
}

function getECDHKeyPair() {
  return ecdhKeyPair;
}

function getPublicKey() {
  return exportedPublicKey;
}

function getSharedSecret() {
  return sharedSecretBase64;
}

function getSessionKey() {
  return sessionKey;
}

function getExportedSessionKey() {
  return exportedSessionKey;
}

window.e2eeCrypto = {
  generateECDHKeyPair,
  importPeerPublicKey,
  deriveSharedSecret,
  deriveSessionKeyFromSharedSecret,
  deriveSharedSessionKey,
  encryptMessage,
  getECDHKeyPair,
  getPublicKey,
  getSharedSecret,
  getSessionKey,
  getExportedSessionKey,
};
