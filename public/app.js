const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");
const messagePanel = document.getElementById("message-panel");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");

let currentRoom = null;
let currentUsername = null;
let hasJoined = false;
let peerPublicKey = null;
let secureSessionReady = false;
let localKeyReady = false;
let pendingPeerKeyPayload = null;
let lastDerivedPeerKey = null;

function setStatus(message) {
  if (!statusText) return;
  statusText.textContent = message;
}

function setMessagePanelVisible(visible) {
  if (!messagePanel) return;

  messagePanel.classList.toggle("hidden", !visible);

  if (sendBtn) {
    sendBtn.disabled = !visible;
  }
}

async function deriveSessionFromPeer(username, publicKey) {
  peerPublicKey = publicKey;

  console.log("Received peer public key from:", username);
  console.log("Peer public key:", peerPublicKey);

  setStatus(
    `Received peer public key from ${username}. Deriving session key...`,
  );

  const { sessionKeyBase64 } = await window.e2eeCrypto.deriveSharedSessionKey(
    peerPublicKey,
    currentRoom,
  );

  secureSessionReady = true;
  lastDerivedPeerKey = publicKey;

  console.log("Secure session ready:", secureSessionReady);
  console.log("Derived session key:", sessionKeyBase64);

  setStatus("Session secure.");
  document.body.classList.add("secure-session");
  setMessagePanelVisible(true);
}

joinBtn.addEventListener("click", () => {
  const username = usernameInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!username || !roomId) {
    console.log("Username and room are required");
    setStatus("Username and room are required.");
    return;
  }

  if (hasJoined && currentRoom === roomId) {
    setStatus("You already joined this room.");
    return;
  }

  if (hasJoined && currentRoom !== roomId) {
    setStatus("You are already in a room.");
    return;
  }

  setStatus("Joining room...");
  socket.emit("join-room", { roomId, username });
});

socket.on("joined-room", async ({ roomId, username }) => {
  try {
    hasJoined = true;
    currentRoom = roomId;
    currentUsername = username;
    secureSessionReady = false;
    localKeyReady = false;
    pendingPeerKeyPayload = null;
    lastDerivedPeerKey = null;

    document.body.classList.remove("secure-session");
    setMessagePanelVisible(false);
    setStatus("Joined room. Generating ECDH keys...");

    const { publicKey } = await window.e2eeCrypto.generateECDHKeyPair();
    localKeyReady = true;

    console.log("Joined room:", roomId);
    console.log("Username:", username);
    console.log("My public key:", publicKey);

    setStatus("ECDH keys ready. Sending public key...");

    socket.emit("public-key", { roomId, username, publicKey });

    if (pendingPeerKeyPayload) {
      const { username: peerUsername, publicKey: pendingPublicKey } =
        pendingPeerKeyPayload;

      pendingPeerKeyPayload = null;
      await deriveSessionFromPeer(peerUsername, pendingPublicKey);
    }
  } catch (error) {
    console.error("ECDH generation failed:", error);
    setStatus("Failed to generate ECDH keys.");
  }
});

socket.on("peer-public-key", async ({ username, publicKey }) => {
  try {
    if (!localKeyReady) {
      pendingPeerKeyPayload = { username, publicKey };
      setStatus(
        `Received peer public key from ${username}. Waiting for local key...`,
      );
      return;
    }

    if (secureSessionReady && publicKey === lastDerivedPeerKey) {
      console.log("Duplicate peer public key ignored");
      return;
    }

    await deriveSessionFromPeer(username, publicKey);
  } catch (error) {
    console.error("Failed to derive shared session key:", error);
    setStatus("Failed to derive secure session.");
  }
});

socket.on("user-joined", ({ username }) => {
  console.log(`${username} joined the room`);
});

socket.on("user-left", ({ username }) => {
  console.log(`${username} left the room`);
  secureSessionReady = false;
  localKeyReady = false;
  pendingPeerKeyPayload = null;
  lastDerivedPeerKey = null;
  document.body.classList.remove("secure-session");
  setMessagePanelVisible(false);
  setStatus(`${username} left the room.`);
});

socket.on("room-full", () => {
  console.log("Room is full.");
  setStatus("Room is full.");
});

socket.on("error-message", (msg) => {
  console.log("Error:", msg);
  setStatus(msg);
});

sendBtn?.addEventListener("click", async () => {
  const plaintext = messageInput?.value.trim();

  if (!plaintext) {
    setStatus("Write a message first.");
    return;
  }

  if (!secureSessionReady) {
    setStatus("Secure session not ready.");
    return;
  }

  try {
    setStatus("Encrypting message...");

    const { ciphertext, iv } =
      await window.e2eeCrypto.encryptMessage(plaintext);

    const encryptedPayload = {
      roomId: currentRoom,
      username: currentUsername,
      ciphertext,
      iv,
    };

    console.log("Encrypted outgoing payload:", encryptedPayload);

    socket.emit("send-encrypted-message", encryptedPayload);

    messageInput.value = "";
    setStatus("Encrypted message sent.");
  } catch (error) {
    console.error("Failed to encrypt outgoing message:", error);
    setStatus("Failed to encrypt message.");
  }
});
