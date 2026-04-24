const generateKeyBtn = document.getElementById("generate-key-btn");
const downloadKeyBtn = document.getElementById("download-key-btn");
const importKeyBtn = document.getElementById("import-key-btn");
const importKeyFileInput = document.getElementById("import-key-file");
const keyStatusText = document.getElementById("key-status");

const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const createRoomBtn = document.getElementById("create-room-btn");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");
const identityFingerprintText = document.getElementById("identity-fingerprint");
const identityPublicKeyText = document.getElementById("identity-public-key");

const modeTabs = document.querySelectorAll(".mode-tab");
const modePanels = document.querySelectorAll(".mode-panel");

const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;
const USERNAME_REGEX = /^[A-Za-z0-9_-]{1,24}$/;

function setRoomMode(mode) {
  modeTabs.forEach((tab) => {
    const isActive = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  modePanels.forEach((panel) => {
    const isActive = panel.dataset.panel === mode;
    panel.classList.toggle("hidden-mode", !isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
  });
}

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setRoomMode(tab.dataset.mode);
    setStatus("");
  });
});

function normalizeUsername(username) {
  return username.trim().replace(/\s+/g, "_").slice(0, 24);
}

function validateUsername(username) {
  if (!username) return "Username is required.";
  if (!USERNAME_REGEX.test(username)) {
    return "Username can only use letters, numbers, _ or - and must be max 24 characters.";
  }
  return "";
}

function setStatus(message) {
  if (!statusText) return;
  statusText.textContent = message;
}

function setKeyStatus(message) {
  if (!keyStatusText) return;
  keyStatusText.textContent = message;
}

const savedUsername = sessionStorage.getItem("chatUsername");
const savedRoomId = sessionStorage.getItem("chatRoomId");

if (savedUsername && usernameInput) {
  usernameInput.value = savedUsername;
}

if (savedRoomId && roomInput) {
  roomInput.value = savedRoomId;
}

let hasIdentityKey = false;

async function renderIdentityInfo(publicKey) {
  if (!publicKey) {
    if (identityFingerprintText) {
      identityFingerprintText.textContent = "No identity key loaded";
    }

    if (identityPublicKeyText) {
      identityPublicKeyText.textContent = "";
    }

    return;
  }

  const fingerprint =
    await window.e2eeCrypto.getPublicKeyFingerprint(publicKey);

  if (identityFingerprintText) {
    identityFingerprintText.textContent = fingerprint;
  }

  if (identityPublicKeyText) {
    identityPublicKeyText.textContent = publicKey;
  }
}

async function initializeIdentityKeyState() {
  sessionStorage.removeItem("identityKeyBundle");

  try {
    const persistedIdentity =
      await window.e2eeCrypto.loadPersistedIdentityKeyPair();

    if (!persistedIdentity?.publicKey) {
      sessionStorage.removeItem("identityPublicKey");
      sessionStorage.removeItem("identityKeyLoaded");
      await renderIdentityInfo(null);
      return;
    }

    hasIdentityKey = true;
    if (downloadKeyBtn) downloadKeyBtn.disabled = false;

    sessionStorage.setItem("identityPublicKey", persistedIdentity.publicKey);
    sessionStorage.setItem("identityKeyLoaded", "true");

    await renderIdentityInfo(persistedIdentity.publicKey);
    setKeyStatus("Identity key loaded from this browser.");
  } catch (err) {
    console.error(err);
    sessionStorage.removeItem("identityPublicKey");
    sessionStorage.removeItem("identityKeyLoaded");
    await renderIdentityInfo(null);
    setKeyStatus("Failed to load saved identity key.");
  }
}

initializeIdentityKeyState();

generateKeyBtn?.addEventListener("click", async () => {
  try {
    setKeyStatus("Generating identity key...");

    const { publicKey } = await window.e2eeCrypto.generateECDHKeyPair();

    hasIdentityKey = true;
    if (downloadKeyBtn) {
      downloadKeyBtn.disabled = false;
    }

    sessionStorage.setItem("identityPublicKey", publicKey);
    sessionStorage.setItem("identityKeyLoaded", "true");

    await renderIdentityInfo(publicKey);

    setKeyStatus(
      "Identity key generated. Click 'Download backup key' to save an encrypted copy!",
    );
  } catch (err) {
    console.error(err);
    setKeyStatus("Failed to generate key.");
  }
});

downloadKeyBtn?.addEventListener("click", async () => {
  try {
    const passphrase = window.prompt(
      "Enter a passphrase to encrypt your key file:",
    );

    if (!passphrase) {
      setKeyStatus("Encrypted key download cancelled.");
      return;
    }

    const confirmPassphrase = window.prompt(
      "Re-enter the passphrase to confirm:",
    );

    if (passphrase !== confirmPassphrase) {
      setKeyStatus("Passphrases did not match.");
      return;
    }

    const json =
      await window.e2eeCrypto.exportEncryptedIdentityKeyBundleJson(passphrase);

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "identity-key.encrypted.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);

    setKeyStatus(
      "Encrypted key downloaded. Keep both the file and passphrase safe.",
    );
  } catch (err) {
    console.error(err);
    setKeyStatus("Failed to download encrypted key.");
  }
});

importKeyBtn?.addEventListener("click", () => {
  importKeyFileInput?.click();
});

importKeyFileInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const passphrase = window.prompt(
      "Enter the passphrase used to encrypt this key file:",
    );

    if (!passphrase) {
      setKeyStatus("Encrypted key import cancelled.");
      event.target.value = "";
      return;
    }

    const { publicKey } =
      await window.e2eeCrypto.importEncryptedIdentityKeyBundle(
        text,
        passphrase,
      );

    hasIdentityKey = true;
    if (downloadKeyBtn) downloadKeyBtn.disabled = false;

    sessionStorage.setItem("identityPublicKey", publicKey);
    sessionStorage.setItem("identityKeyLoaded", "true");
    setKeyStatus("Encrypted identity key imported successfully.");
    await renderIdentityInfo(publicKey);
  } catch (err) {
    console.error(err);
    setKeyStatus("Invalid key file or incorrect passphrase.");
  }

  event.target.value = "";
});

createRoomBtn?.addEventListener("click", () => {
  const username = normalizeUsername(usernameInput?.value || "");
  const usernameError = validateUsername(username);

  if (usernameError) {
    setStatus(usernameError);
    return;
  }

  if (!username) {
    setStatus("Username is required.");
    return;
  }

  if (!hasIdentityKey) {
    setStatus(
      "You must generate or import an identity key before creating a room.",
    );
    return;
  }

  setStatus("Generating secure room code...");
  socket.emit("create-room");
});

socket.on("room-created", ({ roomId }) => {
  const username = normalizeUsername(usernameInput?.value || "");
  const usernameError = validateUsername(username);

  if (usernameError) {
    setStatus(usernameError);
    return;
  }

  if (!username) {
    setStatus("Username is required.");
    return;
  }

  sessionStorage.setItem("chatUsername", username);
  sessionStorage.setItem("chatRoomId", roomId);

  if (roomInput) {
    roomInput.value = roomId;
  }

  window.location.href = "/chat.html";
});

joinBtn?.addEventListener("click", () => {
  const username = normalizeUsername(usernameInput?.value || "");
  const usernameError = validateUsername(username);
  const roomId = roomInput?.value.trim();

  if (usernameError) {
    setStatus(usernameError);
    return;
  }

  if (!username || !roomId) {
    setStatus("Username and room code are required.");
    return;
  }

  if (!ROOM_ID_REGEX.test(roomId)) {
    setStatus("Invalid room code format.");
    return;
  }

  if (!hasIdentityKey) {
    setStatus("You must generate or import an identity key before joining.");
    return;
  }

  setStatus("Checking room code...");

  socket.emit("validate-room", { roomId }, ({ ok, message }) => {
    if (!ok) {
      setStatus(message || "Invalid room code.");
      return;
    }

    sessionStorage.setItem("chatUsername", username);
    sessionStorage.setItem("chatRoomId", roomId);

    window.location.href = "/chat.html";
  });
});

socket.on("error-message", (msg) => {
  setStatus(msg);
});
