// restoring the chat session state from the join page
const currentUsername = sessionStorage.getItem("chatUsername");
const currentRoom = sessionStorage.getItem("chatRoomId");

// DOM elements
const chatRoom = document.getElementById("chat-room");
const chatUsername = document.getElementById("chat-username");
const chatStatusBadge = document.getElementById("chat-status-badge");
const chatMessages = document.getElementById("chat-messages");
const emptyState = document.getElementById("empty-state");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const leaveRoomBtn = document.getElementById("leave-room-btn");

const localFingerprintText = document.getElementById("local-fingerprint");
const peerFingerprintText = document.getElementById("peer-fingerprint");
const peerUsernameText = document.getElementById("peer-identity-username");
const peerFingerprintStatusText = document.getElementById("peer-fingerprint-status");

// payload size limits
const MAX_INCOMING_CIPHERTEXT_LENGTH = 20_000;
const MAX_INCOMING_NONCE_LENGTH = 100;
const MAX_OUTGOING_MESSAGE_LENGTH = 2_000;

// state (for the current chat session)
let secureSessionReady = false;
let localKeyReady = false;
let pendingPeerKeyPayload = null;
let lastDerivedPeerKey = null;
let systemStatusRow = null;
let lastJoinedRoomId = null;
let sendCounter = 0;
let lastReceivedCounter = -1;

// helpers for key fingerprints and to display the identity of the peer
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
    fingerprintStatus = "Warning: Peer key changed";

    appendMessage({
      sender: "System",
      text: `Warning! ${username}'s key has changed. Verify the new fingerprint with them.`,
      type: "system",
    });
  }

  if (peerUsernameText) {
    peerUsernameText.textContent = username || "Peer";
  }

  peerFingerprintText.textContent = fingerprint;
  setPeerFingerprintStatus(fingerprintStatus);
}

// load the local identity key before starting ECDH
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

// if someone opens /chat.html directly, we send them back to the join page
if (!currentUsername || !currentRoom) {
  sessionStorage.removeItem("chatUsername");
  sessionStorage.removeItem("chatRoomId");
  console.warn("Missing chat session state :( Redirecting to join page.");
  window.location.replace("/");
  throw new Error("Missing chat session state");
}

chatRoom.textContent = currentRoom;
chatUsername.textContent = currentUsername;

// some UI helpers for the chat state and messages
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
    systemStatusRow.className = "message-row system";

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

function validateEncryptedMessagePayload({ username, ciphertext, nonce }) {
  if (
    typeof username !== "string" ||
    typeof ciphertext !== "string" ||
    typeof nonce !== "string" ||
    ciphertext.length > MAX_INCOMING_CIPHERTEXT_LENGTH ||
    nonce.length > MAX_INCOMING_NONCE_LENGTH
  ) {
    throw new Error("Invalid encrypted message payload");
  }
}

function validateDecryptedMessagePayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.counter !== "number" ||
    typeof payload.text !== "string"
  ) {
    throw new Error("Invalid decrypted message payload");
  }
}

function handleReplayCheck(counter) {
  if (counter > lastReceivedCounter) {
    lastReceivedCounter = counter;
    return true;
  }

  appendMessage({
    sender: "System",
    text: "Rejected possible replayed message.",
    type: "system",
  });
  return false;
}

function validateOutgoingMessage(plaintext) {
  if (plaintext.length > MAX_OUTGOING_MESSAGE_LENGTH) {
    appendMessage({
      sender: "System",
      text: `Message is too long. Please keep it under ${MAX_OUTGOING_MESSAGE_LENGTH} characters.`,
      type: "system",
    });
    return false;
  }

  return true;
}

// establish the AES-GCM session key from the peer public key
async function deriveSessionFromPeer(username, publicKey) {
  await window.e2eeCrypto.deriveSharedSessionKey(publicKey, currentRoom);

  sendCounter = 0;
  lastReceivedCounter = -1;
  secureSessionReady = true;
  lastDerivedPeerKey = publicKey;

  setChatStatus("secure");
  setComposerEnabled(true);
}

// Socket.IO event handlers
socket.on("connect", () => {
  setChatStatus("connecting");
  setComposerEnabled(false);
  setSystemStatusMessage("Connected. Joining secure chat...");

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
        ? "Rejoined room. Reusing the identity key and establishing a secure session..."
        : "Joined room. Using the identity key and establishing a secure session...",
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

    setSystemStatusMessage("Peer key received. Establishing a secure session...");

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
    type: "system",
  });
});

socket.on("user-left", async ({ username }) => {
  await renderPeerIdentity("", null);
  setPeerFingerprintStatus("");

  appendMessage({
    sender: "System",
    text: `${username} left the room.`,
    type: "system",
  });

  secureSessionReady = false;
  pendingPeerKeyPayload = null;
  lastDerivedPeerKey = null;

  setChatStatus("connecting");
  setComposerEnabled(false);
  setSystemStatusMessage("The other user left the room :( Waiting for a user to join...");
});

socket.on("room-full", () => {
  appendMessage({
    sender: "System",
    text: "Room is full.",
    type: "system",
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
    type: "system",
  });
});

socket.on("receive-encrypted-message", async (encryptedMessage) => {
  try {
    validateEncryptedMessagePayload(encryptedMessage);

    const { username, ciphertext, nonce } = encryptedMessage;
    const decrypted = await window.e2eeCrypto.decryptMessage(ciphertext, nonce);
    const payload = JSON.parse(decrypted);

    validateDecryptedMessagePayload(payload);

    if (!handleReplayCheck(payload.counter)) return;

    appendMessage({
      sender: username,
      text: payload.text,
      type: "theirs",
    });
  } catch (error) {
    console.error("Failed to decrypt incoming message:", error);
    appendMessage({
      sender: "System",
      text: "Failed to decrypt incoming message.",
      type: "system",
    });
  }
});

// user actions
leaveRoomBtn?.addEventListener("click", () => {
  sessionStorage.removeItem("chatUsername");
  sessionStorage.removeItem("chatRoomId");

  secureSessionReady = false;
  localKeyReady = false;
  pendingPeerKeyPayload = null;
  lastDerivedPeerKey = null;

  if (chatInput) {
    chatInput.value = "";
  }

  socket.disconnect();
  window.location.replace("/");
});

chatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const plaintext = chatInput?.value.trim();

  if (!plaintext || !secureSessionReady) return;
  if (!validateOutgoingMessage(plaintext)) return;

  try {
    const payload = {
      counter: sendCounter++,
      text: plaintext,
    };

    const { ciphertext, nonce } = await window.e2eeCrypto.encryptMessage(
      JSON.stringify(payload),
    );

    socket.emit("send-encrypted-message", {
      roomId: currentRoom,
      ciphertext,
      nonce,
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
