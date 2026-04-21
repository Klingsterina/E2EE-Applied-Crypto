const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const createRoomBtn = document.getElementById("create-room-btn");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");

const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;

function setStatus(message) {
  if (!statusText) return;
  statusText.textContent = message;
}

const savedUsername = sessionStorage.getItem("chatUsername");
const savedRoomId = sessionStorage.getItem("chatRoomId");

if (savedUsername && usernameInput) {
  usernameInput.value = savedUsername;
}

if (savedRoomId && roomInput) {
  roomInput.value = savedRoomId;
}

createRoomBtn?.addEventListener("click", () => {
  const username = usernameInput?.value.trim();

  if (!username) {
    setStatus("Username is required.");
    return;
  }

  setStatus("Generating secure room code...");
  socket.emit("create-room");
});

socket.on("room-created", ({ roomId }) => {
  const username = usernameInput?.value.trim();

  if (!username) {
    setStatus("Username is required.");
    return;
  }

  sessionStorage.setItem("chatUsername", username);
  sessionStorage.setItem("chatRoomId", roomId);

  window.location.href = "/chat.html";
});

joinBtn?.addEventListener("click", () => {
  const username = usernameInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!username || !roomId) {
    setStatus("Username and room code are required.");
    return;
  }

  if (!ROOM_ID_REGEX.test(roomId)) {
    setStatus("Invalid room code format.");
    return;
  }

  sessionStorage.setItem("chatUsername", username);
  sessionStorage.setItem("chatRoomId", roomId);

  window.location.href = "/chat.html";
});

socket.on("error-message", (msg) => {
  setStatus(msg);
});
