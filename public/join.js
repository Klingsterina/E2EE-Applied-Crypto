const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");

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

joinBtn?.addEventListener("click", () => {
  const username = usernameInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!username || !roomId) {
    setStatus("Username and room are required.");
    return;
  }

  sessionStorage.setItem("chatUsername", username);
  sessionStorage.setItem("chatRoomId", roomId);

  window.location.href = "/chat.html";
});
