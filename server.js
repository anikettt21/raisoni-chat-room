const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Serve the main HTML file for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Chat server is running' });
});

// User storage file
const USERS_FILE = path.join(__dirname, 'users.json');
let registeredUsers = new Map(); // username -> { passwordHash, avatar, created }

// Load users from file
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      const users = JSON.parse(data);
      registeredUsers = new Map(Object.entries(users));
      console.log(`Loaded ${registeredUsers.size} users from storage.`);
    }
  } catch (err) {
    console.error('Error loading users:', err);
  }
}

// Save users to file
function saveUsers() {
  try {
    const users = Object.fromEntries(registeredUsers);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving users:', err);
  }
}

loadUsers();

// State
const connectedUsers = new Map(); // socketId -> userData
const recentMessages = [];
const MAX_MESSAGES = 200;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const typingUsers = new Map();
const privateChats = new Map();
const userPrivateChats = new Map();
const messageLimits = new Map();
const MESSAGE_RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW = 60000;

// Helpers
function checkRateLimit(socketId) {
  const now = Date.now();
  const userLimit = messageLimits.get(socketId);
  if (!userLimit || now > userLimit.resetTime) {
    messageLimits.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (userLimit.count >= MESSAGE_RATE_LIMIT) return false;
  userLimit.count++;
  return true;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') return '';
  return message.trim().substring(0, 500);
}

function sanitizeUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const cleaned = username.trim().replace(/[<>\"'&]/g, '').substring(0, 20);
  return cleaned || null;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function pruneExpiredMessages() {
  const now = Date.now();
  const toDelete = [];
  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const ts = new Date(msg.timestamp).getTime();
    if (isFinite(ts) && now - ts > MESSAGE_TTL_MS) {
      toDelete.push(String(msg.id));
    }
  }
  if (toDelete.length === 0) return;
  for (const id of toDelete) {
    const idx = recentMessages.findIndex(m => String(m.id) === id);
    if (idx !== -1) recentMessages.splice(idx, 1);
  }
  io.emit('message deleted', toDelete);
}

function addMessageToHistory(messageData) {
  if (!messageData.reactions) messageData.reactions = {};
  if (!messageData.id) messageData.id = String(Date.now() + Math.random());

  recentMessages.push({ ...messageData, id: String(messageData.id) });

  pruneExpiredMessages();
  if (recentMessages.length > MAX_MESSAGES) {
    recentMessages.splice(0, recentMessages.length - MAX_MESSAGES);
  }
}

function updateMessageReactions(messageId, reaction, username, action) {
  const message = recentMessages.find(msg => String(msg.id) === String(messageId));
  if (!message) return false;
  if (!message.reactions) message.reactions = {};

  if (action === 'add') {
    for (const [existingReaction, users] of Object.entries(message.reactions)) {
      const userIndex = users.indexOf(username);
      if (userIndex > -1) {
        users.splice(userIndex, 1);
        if (users.length === 0) delete message.reactions[existingReaction];
      }
    }
    if (!message.reactions[reaction]) message.reactions[reaction] = [];
    if (!message.reactions[reaction].includes(username)) message.reactions[reaction].push(username);
  } else if (action === 'remove') {
    if (message.reactions[reaction]) {
      const idx = message.reactions[reaction].indexOf(username);
      if (idx > -1) {
        message.reactions[reaction].splice(idx, 1);
        if (message.reactions[reaction].length === 0) delete message.reactions[reaction];
      }
    }
  }
  return true;
}

function broadcastUserCount() {
  const count = connectedUsers.size;
  const onlineUsers = Array.from(connectedUsers.values()).map(u => ({
    username: u.username,
    avatar: u.avatar || '😊'
  }));
  io.emit('user count', count);
  io.emit('online users', onlineUsers);
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [socketId, limitData] of messageLimits.entries()) {
    if (now > limitData.resetTime) messageLimits.delete(socketId);
  }
  for (const [socketId] of messageLimits.entries()) {
    if (!connectedUsers.has(socketId)) messageLimits.delete(socketId);
  }
}

// Private Chat Helper
function getOrCreatePrivateChat(user1, user2) {
  const participants = [user1, user2].sort();
  const chatId = `pc_${participants.join('_')}`;

  if (!privateChats.has(chatId)) {
    privateChats.set(chatId, {
      id: chatId,
      participants: new Set(participants),
      messages: [],
      created: new Date().toISOString()
    });
  }
  return chatId;
}

function addPrivateMessageToHistory(chatId, messageData) {
  const chat = privateChats.get(chatId);
  if (!chat) return;

  chat.messages.push(messageData);
  if (chat.messages.length > 100) {
    chat.messages.shift();
  }
}

// Socket Logic
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // LOGIN
  socket.on('login', (data) => {
    try {
      const { username, password } = data;
      if (!username || !password) {
        socket.emit('login_error', { message: 'Username and password required' });
        return;
      }

      const user = registeredUsers.get(username);
      if (!user || user.passwordHash !== hashPassword(password)) {
        socket.emit('login_error', { message: 'Invalid username or password' });
        return;
      }

      const existingUser = Array.from(connectedUsers.values()).find(u => u.username === username);
      if (existingUser) {
        socket.emit('login_error', { message: 'User already logged in' });
        // return; 
      }

      connectedUsers.set(socket.id, {
        username: username,
        avatar: user.avatar,
        socketId: socket.id,
        joinTime: new Date()
      });

      socket.emit('login_success', {
        username: username,
        avatar: user.avatar
      });

      io.emit('user joined', {
        username: username,
        avatar: user.avatar,
        timestamp: new Date().toISOString()
      });

      broadcastUserCount();

      pruneExpiredMessages();
      const now = Date.now();
      const recent24h = recentMessages.filter(m => {
        const ts = new Date(m.timestamp).getTime();
        return isFinite(ts) && now - ts <= MESSAGE_TTL_MS;
      });
      socket.emit('recent messages', recent24h);

      console.log(`${username} logged in.`);
    } catch (e) {
      console.error(e);
      socket.emit('login_error', { message: 'Server error during login' });
    }
  });

  // REGISTER
  socket.on('register', (data) => {
    try {
      const { username, password, avatar } = data;
      if (!username || !password) {
        socket.emit('register_error', { message: 'Missing fields' });
        return;
      }

      // Strict username validation
      const usernameRegex = /^[a-zA-Z0-9_]+$/;
      if (!usernameRegex.test(username)) {
        socket.emit('register_error', { message: 'Username can only contain letters, numbers, and underscores' });
        return;
      }

      const sanitizedUsername = sanitizeUsername(username);
      if (!sanitizedUsername || sanitizedUsername.length < 3) {
        socket.emit('register_error', { message: 'Invalid username (3-20 chars)' });
        return;
      }

      if (registeredUsers.has(sanitizedUsername)) {
        socket.emit('register_error', { message: 'Username already taken' });
        return;
      }

      const newUser = {
        passwordHash: hashPassword(password),
        avatar: avatar || '😊',
        created: new Date().toISOString()
      };

      registeredUsers.set(sanitizedUsername, newUser);
      saveUsers();

      socket.emit('register_success', { message: 'Account created! Please log in.' });
      console.log(`New user registered: ${sanitizedUsername}`);
    } catch (e) {
      console.error(e);
      socket.emit('register_error', { message: 'Server error during registration' });
    }
  });

  // CHAT MESSAGE
  socket.on("chat message", (data) => {
    try {
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      const userData = connectedUsers.get(socket.id);
      const username = userData ? userData.username : 'Unknown';
      const messageText = sanitizeMessage(data && data.message);
      if (!messageText) return;

      const messageData = {
        id: String(Date.now() + Math.random()),
        username,
        message: messageText,
        replyTo: data.replyTo || null,
        timestamp: new Date().toISOString(),
        reactions: {},
        avatar: userData ? userData.avatar : '😊'
      };

      addMessageToHistory(messageData);
      io.emit('chat message', messageData);
    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });

  // REACTIONS
  socket.on('message reaction', (data) => {
    try {
      const { messageId, reaction, username, action } = data || {};
      if (!messageId || !reaction || !username || !action) return;
      const ok = updateMessageReactions(messageId, reaction, username, action);
      if (ok) {
        io.emit('message reaction', { messageId, reaction, username, action });
      }
    } catch (error) {
      console.error('Error handling message reaction:', error);
    }
  });

  // TYPING
  socket.on('typing', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      const username = userData ? userData.username : null;
      if (!username) return;
      typingUsers.set(username, socket.id);
      socket.broadcast.emit('typing', { username });
    } catch (error) {
      console.error('Error handling typing:', error);
    }
  });

  socket.on('stop typing', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      const username = userData ? userData.username : null;
      if (!username) return;
      typingUsers.delete(username);
      socket.broadcast.emit('stop typing', { username });
    } catch (error) {
      console.error('Error handling stop typing:', error);
    }
  });

  // PRIVATE CHATS
  socket.on('invite to private chat', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) {
        socket.emit('error', { message: 'User not found. Please refresh.' });
        return;
      }
      const { targetUsername } = data;
      if (!targetUsername || targetUsername === userData.username) return;

      const targetUser = Array.from(connectedUsers.values()).find(user => user.username === targetUsername);
      if (!targetUser) {
        socket.emit('error', { message: 'User is not online' });
        return;
      }

      const targetSocket = io.sockets.sockets.get(targetUser.socketId);
      if (targetSocket) {
        targetSocket.emit('private chat invite', {
          fromUsername: userData.username,
          timestamp: new Date().toISOString()
        });
        socket.emit('private chat invite sent', {
          toUsername: targetUsername,
          timestamp: new Date().toISOString()
        });
      }
    } catch (e) { console.error(e); }
  });

  socket.on('accept private chat', (data) => {
    // ... simplified existing logic ...
    const userData = connectedUsers.get(socket.id);
    if (!userData) return;
    const { fromUsername } = data;
    const chatId = getOrCreatePrivateChat(userData.username, fromUsername);

    const senderUser = Array.from(connectedUsers.values()).find(user => user.username === fromUsername);
    if (senderUser) {
      const senderSocket = io.sockets.sockets.get(senderUser.socketId);
      if (senderSocket) {
        senderSocket.emit('private chat accepted', { byUsername: userData.username, chatId });
      }
    }

    const chat = privateChats.get(chatId);
    if (chat && chat.messages) {
      socket.emit('private chat history', { chatId, messages: chat.messages });
      if (senderUser) {
        const senderSocket = io.sockets.sockets.get(senderUser.socketId);
        if (senderSocket) senderSocket.emit('private chat history', { chatId, messages: chat.messages });
      }
    }
  });

  socket.on('private message', (data) => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) return;
    const { chatId, message, toUsername } = data;
    // ... logic ...
    const msgData = {
      id: String(Date.now()),
      username: userData.username,
      message: sanitizeMessage(message),
      timestamp: new Date().toISOString(),
      isPrivate: true,
      chatId
    };
    addPrivateMessageToHistory(chatId, msgData);

    const targetUser = Array.from(connectedUsers.values()).find(u => u.username === toUsername);
    if (targetUser) {
      const s = io.sockets.sockets.get(targetUser.socketId);
      if (s) s.emit('private message', msgData);
    }
    socket.emit('private message', msgData);
  });

  // DISCONNECT
  socket.on("disconnect", (reason) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user) {
        const username = user.username;
        connectedUsers.delete(socket.id);
        typingUsers.delete(username);
        io.emit('user left', { username, timestamp: new Date().toISOString() });
        broadcastUserCount();
        console.log(`${username} disconnected.`);
      }
    } catch (error) {
      console.error('Error during disconnect cleanup:', error);
    }
  });
});

setInterval(cleanupRateLimits, 300000);
setInterval(() => {
  try { pruneExpiredMessages(); } catch (e) { }
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Real-time chat server running at http://localhost:${PORT}`);
});