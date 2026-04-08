let ecdhKeyPair = null;
let exportedPublicKey = null;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
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

function getECDHKeyPair() {
  return ecdhKeyPair;
}

function getPublicKey() {
  return exportedPublicKey;
}

window.e2eeCrypto = {
  generateECDHKeyPair,
  getECDHKeyPair,
  getPublicKey,
};
