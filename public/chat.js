const currentUsername = sessionStorage.getItem("chatUsername");
const currentRoom = sessionStorage.getItem("chatRoomId");

const chatRoom = document.getElementById("chat-room");
const chatUsername = document.getElementById("chat-username");
const chatStatusBadge = document.getElementById("chat-status-badge");
const chatMessages = document.getElementById("chat-messages");
const emptyState = document.getElementById("empty-state");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

const localFingerprintText = document.getElementById("local-fingerprint");
const peerFingerprintText = document.getElementById("peer-fingerprint");
const peerUsernameText = document.getElementById("peer-identity-username");
const peerFingerprintStatusText = document.getElementById("peer-fingerprint-status");

let secureSessionReady = false;
let localKeyReady = false;
let pendingPeerKeyPayload = null;
let lastDerivedPeerKey = null;
let systemStatusRow = null;
let lastJoinedRoomId = null;

function getPeerFingerprintStorageKey() {
  return `knownPeerFingerprint:${currentRoom}`;
}

function setPeerFingerprintStatus(text) {
  if (!peerFingerprintStatusText) return;
  peerFingerprintStatusText.textContent = text;
}

async function renderLocalIdentity(publicKey) {
  if (!localFingerprintText) return;

  if (!publicKey) {
    localFingerprintText.textContent = "Unavailable";
    return;
  }

  const fingerprint =
    await window.e2eeCrypto.getPublicKeyFingerprint(publicKey);

  localFingerprintText.textContent = fingerprint;
}

async function renderPeerIdentity(username, publicKey) {
  if (!peerFingerprintText) return;

  if (!publicKey) {
    peerFingerprintText.textContent = "Waiting for peer key...";
    setPeerFingerprintStatus("");

    if (peerUsernameText) {
      peerUsernameText.textContent = "";
    }

    return;
  }

  const fingerprint =
    await window.e2eeCrypto.getPublicKeyFingerprint(publicKey);

  const storageKey = getPeerFingerprintStorageKey();
  const knownFingerprint = localStorage.getItem(storageKey);

  let fingerprintStatus = "New peer key";

  if (!knownFingerprint) {
    localStorage.setItem(storageKey, fingerprint);
  } else if (knownFingerprint === fingerprint) {
    fingerprintStatus = "Known peer key";
  } else {
    fingerprintStatus = "Warning: peer key changed";

    appendMessage({
      sender: "System",
      text: "Warning: peer key changed for this room. Verify the fingerprint out of band.",
      type: "theirs",
    });
  }

  if (peerUsernameText) {
    peerUsernameText.textContent = username || "Peer";
  }

  peerFingerprintText.textContent = fingerprint;
  setPeerFingerprintStatus(fingerprintStatus);
}

async function ensureIdentityKeyReady() {
  const existingPublicKey = window.e2eeCrypto.getPublicKey();

  if (existingPublicKey) {
    return existingPublicKey;
  }

  const persistedIdentity =
    await window.e2eeCrypto.loadPersistedIdentityKeyPair();

  if (persistedIdentity?.publicKey) {
    return persistedIdentity.publicKey;
  }

  throw new Error(
    "Missing identity key. Please return to the join page and generate or import your identity key.",
  );
}

if (!currentUsername || !currentRoom) {
  window.location.href = "/";
  throw new Error("Missing chat session state");
}

chatRoom.textContent = currentRoom;
chatUsername.textContent = currentUsername;

function setChatStatus(mode) {
  if (!chatStatusBadge) return;

  chatStatusBadge.classList.remove("connecting", "secure");

  if (mode === "secure") {
    chatStatusBadge.textContent = "Secure";
    chatStatusBadge.classList.add("secure");
    setSystemStatusMessage("");
    return;
  }

  chatStatusBadge.textContent = "Connecting";
  chatStatusBadge.classList.add("connecting");
}

function scrollMessagesToBottom() {
  if (!chatMessages) return;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendMessage({ sender, text, type = "theirs" }) {
  if (emptyState) {
    emptyState.remove();
  }

  const row = document.createElement("div");
  row.className = `message-row ${type}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const meta = document.createElement("span");
  meta.className = "message-meta";
  meta.textContent = type === "mine" ? "You" : sender;

  const body = document.createElement("div");
  body.textContent = text;

  bubble.appendChild(meta);
  bubble.appendChild(body);
  row.appendChild(bubble);
  chatMessages.appendChild(row);

  scrollMessagesToBottom();
}

function setSystemStatusMessage(text) {
  if (!chatMessages) return;

  if (!text) {
    if (systemStatusRow) {
      systemStatusRow.remove();
      systemStatusRow = null;
    }
    return;
  }

  if (emptyState) {
    emptyState.remove();
  }

  if (!systemStatusRow) {
    systemStatusRow = document.createElement("div");
    systemStatusRow.className = "message-row theirs";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = "System";

    const body = document.createElement("div");
    body.className = "system-status-body";

    bubble.appendChild(meta);
    bubble.appendChild(body);
    systemStatusRow.appendChild(bubble);
    chatMessages.appendChild(systemStatusRow);
  }

  const body = systemStatusRow.querySelector(".system-status-body");
  if (body) {
    body.textContent = text;
  }

  scrollMessagesToBottom();
}

function setComposerEnabled(enabled) {
  if (chatInput) chatInput.disabled = !enabled;
  if (chatSendBtn) chatSendBtn.disabled = !enabled;
}

async function deriveSessionFromPeer(username, publicKey) {
  await window.e2eeCrypto.deriveSharedSessionKey(publicKey, currentRoom);

  secureSessionReady = true;
  lastDerivedPeerKey = publicKey;

  setChatStatus("secure");
  setComposerEnabled(true);
}

socket.on("connect", () => {
  setChatStatus("connecting");
  setComposerEnabled(false);
  setSystemStatusMessage("Connected. Rejoining secure chat...");

  socket.emit("join-room", {
    roomId: currentRoom,
    username: currentUsername,
  });
});

socket.on("joined-room", async ({ roomId, username }) => {
  try {
    chatRoom.textContent = roomId;
    chatUsername.textContent = username;

    secureSessionReady = false;
    localKeyReady = false;
    pendingPeerKeyPayload = null;
    lastDerivedPeerKey = null;

    if (chatMessages) {
      chatMessages.innerHTML = "";
    }

    systemStatusRow = null;

    setChatStatus("connecting");
    setComposerEnabled(false);
    await renderPeerIdentity("", null);
    setPeerFingerprintStatus("");

    const publicKey = await ensureIdentityKeyReady();
    await renderLocalIdentity(publicKey);
    localKeyReady = true;

    const isRejoiningSameRoom = lastJoinedRoomId === roomId;

    setSystemStatusMessage(
      isRejoiningSameRoom
        ? "Rejoined room. Reusing identity key and establishing secure session..."
        : "Joined room. Reusing identity key and establishing secure session...",
    );

    lastJoinedRoomId = roomId;

    socket.emit("public-key", {
      roomId,
      publicKey,
    });

    if (pendingPeerKeyPayload) {
      const { username: peerUsername, publicKey: pendingPublicKey } =
        pendingPeerKeyPayload;

      pendingPeerKeyPayload = null;
      await renderPeerIdentity(peerUsername, pendingPublicKey);
      await deriveSessionFromPeer(peerUsername, pendingPublicKey);
    }
  } catch (error) {
    console.error("Identity key setup failed:", error);

    setComposerEnabled(false);
    setChatStatus("connecting");
    setSystemStatusMessage(
      error?.message ||
        "Identity key setup failed. Please return to the join page.",
    );
  }
});

socket.on("peer-public-key", async ({ username, publicKey }) => {
  try {
    if (!localKeyReady) {
      pendingPeerKeyPayload = { username, publicKey };
      return;
    }

    if (secureSessionReady && publicKey === lastDerivedPeerKey) {
      return;
    }

    setSystemStatusMessage("Peer key received. Establishing secure session...");

    await renderPeerIdentity(username, publicKey);
    await deriveSessionFromPeer(username, publicKey);
  } catch (error) {
    console.error("Failed to derive shared session key:", error);
  }
});

socket.on("user-joined", ({ username }) => {
  appendMessage({
    sender: "System",
    text: `${username} joined the room.`,
    type: "theirs",
  });
});

socket.on("user-left", async ({ username }) => {
  await renderPeerIdentity("", null);
  setPeerFingerprintStatus("");

  appendMessage({
    sender: "System",
    text: `${username} left the room.`,
    type: "theirs",
  });

  secureSessionReady = false;
  pendingPeerKeyPayload = null;
  lastDerivedPeerKey = null;

  setChatStatus("connecting");
  setComposerEnabled(false);
  setSystemStatusMessage("Peer left. Waiting for a secure peer to join...");
});

socket.on("room-full", () => {
  appendMessage({
    sender: "System",
    text: "Room is full.",
    type: "theirs",
  });
});

socket.on("disconnect", async () => {
  secureSessionReady = false;
  localKeyReady = false;
  pendingPeerKeyPayload = null;
  lastDerivedPeerKey = null;

  await renderPeerIdentity("", null);
  setPeerFingerprintStatus("");

  setChatStatus("connecting");
  setComposerEnabled(false);
  setSystemStatusMessage("Disconnected. Waiting to reconnect...");
});

socket.on("error-message", (msg) => {
  appendMessage({
    sender: "System",
    text: msg,
    type: "theirs",
  });
});

socket.on("receive-encrypted-message", async ({ username, ciphertext, iv }) => {
  try {
    const plaintext = await window.e2eeCrypto.decryptMessage(ciphertext, iv);

    appendMessage({
      sender: username,
      text: plaintext,
      type: "theirs",
    });
  } catch (error) {
    console.error("Failed to decrypt incoming message:", error);

    appendMessage({
      sender: "System",
      text: "Failed to decrypt incoming message.",
      type: "theirs",
    });
  }
});

chatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const plaintext = chatInput?.value.trim();

  if (!plaintext || !secureSessionReady) return;

  try {
    const { ciphertext, iv } =
      await window.e2eeCrypto.encryptMessage(plaintext);

    socket.emit("send-encrypted-message", {
      roomId: currentRoom,
      ciphertext,
      iv,
    });

    appendMessage({
      sender: currentUsername,
      text: plaintext,
      type: "mine",
    });

    chatInput.value = "";
    chatInput.focus();
  } catch (error) {
    console.error("Failed to encrypt outgoing message:", error);
  }
});
