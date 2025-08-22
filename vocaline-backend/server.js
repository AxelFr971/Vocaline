const http = require("http");
const WebSocket = require("ws");

// --- Create HTTP server (so Railway can proxy traffic properly) ---
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Vocaline WebSocket backend is running ✅");
});

// --- Attach WebSocket server to HTTP server ---
const wss = new WebSocket.Server({ server });

console.log(`WebSocket server created, waiting for connections...`);

// --- Global State Management ---
const connectedUsers = new Map();
const matchmakingQueue = [];

// --- Helper: Generate Unique ID ---
function generateUniqueId() {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

// --- Helper: Send message safely ---
function sendMessage(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// --- Update realtime stats to all users ---
function updateRealtimeStats() {
  let connected = connectedUsers.size;
  let waiting = matchmakingQueue.length;
  let activeConversations = 0;

  connectedUsers.forEach((user) => {
    if (user.status === "in-call") {
      activeConversations++;
    }
  });
  activeConversations /= 2;

  const stats = {
    connectedUsers: connected,
    waitingUsers: waiting,
    activeConversations: activeConversations,
  };

  connectedUsers.forEach((userData, userWs) => {
    sendMessage(userWs, "stats_update", stats);
  });
}

// --- Matchmaking Logic ---
function attemptMatch(userWs) {
  const requestingUserData = connectedUsers.get(userWs);
  if (!requestingUserData || requestingUserData.status !== "waiting") return;

  const lastPartnerWs = requestingUserData.lastPartnerWs;
  const eligiblePartners = matchmakingQueue.filter(
    (partnerWs) =>
      partnerWs !== userWs &&
      connectedUsers.get(partnerWs)?.status === "waiting" &&
      partnerWs !== lastPartnerWs
  );

  if (eligiblePartners.length > 0) {
    const partnerWs =
      eligiblePartners[Math.floor(Math.random() * eligiblePartners.length)];
    const partnerData = connectedUsers.get(partnerWs);

    if (
      requestingUserData.status === "waiting" &&
      partnerData?.status === "waiting"
    ) {
      matchmakingQueue.splice(matchmakingQueue.indexOf(userWs), 1);
      matchmakingQueue.splice(matchmakingQueue.indexOf(partnerWs), 1);

      requestingUserData.status = "in-call";
      requestingUserData.partner = partnerWs;
      requestingUserData.lastPartnerWs = null;

      partnerData.status = "in-call";
      partnerData.partner = userWs;
      partnerData.lastPartnerWs = null;

      sendMessage(userWs, "match_found", {
        partnerUsername: partnerData.username,
        initiateCall: true,
      });
      sendMessage(partnerWs, "match_found", {
        partnerUsername: requestingUserData.username,
        initiateCall: false,
      });

      updateRealtimeStats();
    }
  }
}

// --- Handle new connections ---
wss.on("connection", (ws) => {
  const connectionId = generateUniqueId();
  console.log(`[CLIENT_CONNECT]: ${connectionId}`);

  connectedUsers.set(ws, {
    id: connectionId,
    username: "Guest",
    status: "connected",
    partner: null,
    lastPartnerWs: null,
  });

  sendMessage(ws, "welcome", {
    message: "Welcome to Vocaline! Please provide your username.",
  });
  updateRealtimeStats();

  ws.on("message", (msg) => {
    let parsed;
    try {
      parsed = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const user = connectedUsers.get(ws);
    if (!user) return;

    switch (parsed.type) {
      case "join":
        if (!parsed.payload?.username) {
          sendMessage(ws, "error", { message: "Username required" });
          return;
        }
        user.username = parsed.payload.username;
        user.status = "waiting";
        user.lastPartnerWs = null;
        matchmakingQueue.push(ws);
        sendMessage(ws, "status_update", { status: "waiting_for_match" });
        setTimeout(() => attemptMatch(ws), 1000);
        updateRealtimeStats();
        break;

      case "offer":
      case "answer":
      case "candidate":
        if (user.status === "in-call" && user.partner) {
          sendMessage(user.partner, parsed.type, {
            ...parsed.payload,
            from: user.id,
          });
        }
        break;

      case "disconnect_from_matchmaking":
        user.status = "disconnected";
        user.partner = null;
        const idx = matchmakingQueue.indexOf(ws);
        if (idx !== -1) matchmakingQueue.splice(idx, 1);
        sendMessage(ws, "status_update", { status: "disconnected" });
        updateRealtimeStats();
        break;
    }
  });

  ws.on("close", () => {
    console.log(`[CLIENT_DISCONNECT]: ${connectedUsers.get(ws)?.username}`);
    connectedUsers.delete(ws);
    const idx = matchmakingQueue.indexOf(ws);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
    updateRealtimeStats();
  });
});

// --- Start HTTP + WS server ---
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
