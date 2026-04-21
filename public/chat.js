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

let secureSessionReady = false;
let localKeyReady = false;
let pendingPeerKeyPayload = null;
let lastDerivedPeerKey = null;
let systemStatusRow = null;
let lastJoinedRoomId = null;

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
  console.log("Received peer public key from:", username);
  console.log("Peer public key:", publicKey);

  const { sessionKeyBase64 } = await window.e2eeCrypto.deriveSharedSessionKey(
    publicKey,
    currentRoom,
  );

  secureSessionReady = true;
  lastDerivedPeerKey = publicKey;

  console.log("Secure session ready:", secureSessionReady);
  console.log("Derived session key:", sessionKeyBase64);

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
    if (chatMessages) chatMessages.innerHTML = "";
    systemStatusRow = null;

    setChatStatus("connecting");
    setComposerEnabled(false);

    const { publicKey } = await window.e2eeCrypto.generateECDHKeyPair();
    localKeyReady = true;

    console.log("Joined room:", roomId);
    console.log("Username:", username);
    console.log("My public key:", publicKey);

    const isRejoiningSameRoom = lastJoinedRoomId === roomId;

    setSystemStatusMessage(
      isRejoiningSameRoom
        ? "Rejoined room. Establishing secure session..."
        : "Joined room. Establishing secure session...",
    );

    lastJoinedRoomId = roomId;

    socket.emit("public-key", {
      roomId,
      username,
      publicKey,
    });

    if (pendingPeerKeyPayload) {
      const { username: peerUsername, publicKey: pendingPublicKey } =
        pendingPeerKeyPayload;

      pendingPeerKeyPayload = null;
      await deriveSessionFromPeer(peerUsername, pendingPublicKey);
    }
  } catch (error) {
    console.error("ECDH generation failed:", error);
  }
});

socket.on("peer-public-key", async ({ username, publicKey }) => {
  try {
    if (!localKeyReady) {
      pendingPeerKeyPayload = { username, publicKey };
      return;
    }
    appendMessage({
      sender: "System",
      text: `${username} is already in the room. Establishing secure session...`,
      type: "theirs",
    });

    setSystemStatusMessage("Peer key received. Establishing secure session...");

    if (secureSessionReady && publicKey === lastDerivedPeerKey) {
      console.log("Duplicate peer public key ignored");
      return;
    }

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

socket.on("user-left", ({ username }) => {
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

socket.on("disconnect", () => {
  secureSessionReady = false;
  localKeyReady = false;
  pendingPeerKeyPayload = null;
  lastDerivedPeerKey = null;

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
    console.log("Received encrypted payload:", { username, ciphertext, iv });

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
      username: currentUsername,
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
