let ecdhKeyPair = null;
let exportedPublicKey = null;
let sharedSecretBase64 = null;

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

function getECDHKeyPair() {
  return ecdhKeyPair;
}

function getPublicKey() {
  return exportedPublicKey;
}

function getSharedSecret() {
  return sharedSecretBase64;
}

window.e2eeCrypto = {
  generateECDHKeyPair,
  importPeerPublicKey,
  deriveSharedSecret,
  getECDHKeyPair,
  getPublicKey,
  getSharedSecret,
};
