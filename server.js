const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

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

// Health check endpoint for Render
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Chat server is running' });
});

// Add basic error handling for express
app.use((err, req, res, next) => {
  console.error('Express error:', err.stack);
  res.status(500).send('Something went wrong!');
});

// Store connected users and recent messages
const connectedUsers = new Map(); // socketId -> userData
const recentMessages = []; // Store recent messages
const MAX_MESSAGES = 200; // soft cap; TTL cleanup will keep within 24h anyway
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const typingUsers = new Map(); // username -> socketId

// Private chat functionality
const privateChats = new Map(); // chatId -> { participants: Set, messages: [] }
const userPrivateChats = new Map(); // username -> Set of chatIds
const MAX_PRIVATE_MESSAGES = 100;

// Rate limiting
const messageLimits = new Map(); // socketId -> { count, resetTime }
const MESSAGE_RATE_LIMIT = 10; // messages per minute
const RATE_LIMIT_WINDOW = 60000; // 1 minute

function checkRateLimit(socketId) {
  const now = Date.now();
  const userLimit = messageLimits.get(socketId);
  
  if (!userLimit || now > userLimit.resetTime) {
    // Reset or create new limit
    messageLimits.set(socketId, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return true;
  }
  
  if (userLimit.count >= MESSAGE_RATE_LIMIT) {
    return false; // Rate limit exceeded
  }
  
  userLimit.count++;
  return true;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') return '';
  
  // Remove excessive whitespace and limit length
  return message.trim().substring(0, 500);
}

function sanitizeUsername(username) {
  if (!username || typeof username !== 'string') return null;
  
  // Clean username: remove special chars, limit length
  const cleaned = username.trim().replace(/[<>\"'&]/g, '').substring(0, 20);
  return cleaned || null;
}

function addMessageToHistory(messageData) {
  // Initialize reactions if not present
  if (!messageData.reactions) {
    messageData.reactions = {};
  }
  
  // Ensure message has a unique ID as string
  if (!messageData.id) {
    messageData.id = String(Date.now() + Math.random());
  }
  
  recentMessages.push({
    ...messageData,
    id: String(messageData.id)
  });
  
  // Prune by TTL and soft cap
  pruneExpiredMessages();
  if (recentMessages.length > MAX_MESSAGES) {
    recentMessages.splice(0, recentMessages.length - MAX_MESSAGES);
  }
}

// Remove messages older than TTL and broadcast deletions
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
  // Filter out expired
  for (const id of toDelete) {
    const idx = recentMessages.findIndex(m => String(m.id) === id);
    if (idx !== -1) recentMessages.splice(idx, 1);
  }
  // Notify clients
  io.emit('message deleted', toDelete);
}

function updateMessageReactions(messageId, reaction, username, action) {
  const message = recentMessages.find(msg => String(msg.id) === String(messageId));
  if (!message) {
    console.log(`Message not found for reaction: ${messageId}`);
    return false;
  }
  
  if (!message.reactions) {
    message.reactions = {};
  }
  
  if (action === 'add') {
    // Remove any existing reactions by this user first (one reaction per user)
    for (const [existingReaction, users] of Object.entries(message.reactions)) {
      const userIndex = users.indexOf(username);
      if (userIndex > -1) {
        users.splice(userIndex, 1);
        // clean empty arrays
        if (users.length === 0) {
          delete message.reactions[existingReaction];
        }
      }
    }
    
    // Add new reaction
    if (!message.reactions[reaction]) {
      message.reactions[reaction] = [];
    }
    
    if (!message.reactions[reaction].includes(username)) {
      message.reactions[reaction].push(username);
    }
  } else if (action === 'remove') {
    if (message.reactions[reaction]) {
      const idx = message.reactions[reaction].indexOf(username);
      if (idx > -1) {
        message.reactions[reaction].splice(idx, 1);
        if (message.reactions[reaction].length === 0) {
          delete message.reactions[reaction];
        }
      }
    }
  }
  
  return true;
}

function broadcastUserCount() {
  const count = connectedUsers.size;
  const onlineUsers = getOnlineUsers();
  
  console.log(`Broadcasting user count: ${count}, users: ${onlineUsers.join(', ')}`);
  
  // Send both count and full user list
  io.emit('user count', count);
  io.emit('online users', onlineUsers);
}

function getOnlineUsers() {
  return Array.from(connectedUsers.values()).map(user => user.username);
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [socketId, limitData] of messageLimits.entries()) {
    if (now > limitData.resetTime) {
      messageLimits.delete(socketId);
    }
  }
  
  // Also clean up rate limits for disconnected users
  for (const [socketId] of messageLimits.entries()) {
    if (!connectedUsers.has(socketId)) {
      messageLimits.delete(socketId);
    }
  }
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Send only messages from last 24h to newly connected user
  pruneExpiredMessages();
  const now = Date.now();
  const recent24h = recentMessages.filter(m => {
    const ts = new Date(m.timestamp).getTime();
    return isFinite(ts) && now - ts <= MESSAGE_TTL_MS;
  });
  socket.emit('recent messages', recent24h);

  socket.on('user joined', (data) => {
    try {
      // Sanitize and ensure a username
      let username = sanitizeUsername(data && data.username) || `User${Math.floor(Math.random() * 10000)}`;

      // If username already exists for another socket, make it unique
      const existingUser = Array.from(connectedUsers.values()).find(user => user.username === username && user.socketId !== socket.id);
      if (existingUser) {
        username = `${username}_${Math.floor(Math.random() * 1000)}`;
      }

      // Store connected user with the final username
      connectedUsers.set(socket.id, { username, socketId: socket.id, joinTime: new Date() });
      const userData = connectedUsers.get(socket.id);

      // Inform the connecting client of its assigned username (in case server changed it)
      socket.emit('username assigned', {
        username: userData.username,
        timestamp: new Date().toISOString()
      });

      // Broadcast to all clients that a user joined and send updated lists/count
      io.emit('user joined', {
        username: userData.username,
        timestamp: new Date().toISOString()
      });

      // This will emit both 'user count' and 'online users' to everyone
      broadcastUserCount();

      console.log(`${userData.username} joined the chat. Total users: ${connectedUsers.size}`);
    } catch (error) {
      console.error('Error handling user join:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  socket.on('get online users', () => {
    try {
      socket.emit('online users', getOnlineUsers());
    } catch (error) {
      console.error('Error handling get online users:', error);
    }
  });

  socket.on("chat message", (data) => {
    try {
      // Rate limit
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      const username = sanitizeUsername(data && data.username) || (connectedUsers.get(socket.id) && connectedUsers.get(socket.id).username) || 'Unknown';
      const messageText = sanitizeMessage(data && data.message);
      if (!messageText) return;

      const messageData = {
        id: String(Date.now() + Math.random()),
        username,
        message: messageText,
        timestamp: new Date().toISOString(),
        reactions: {}
      };

      addMessageToHistory(messageData);
      io.emit('chat message', messageData);
    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });

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

  socket.on('typing', (data) => {
    try {
      const username = sanitizeUsername(data && data.username) || (connectedUsers.get(socket.id) && connectedUsers.get(socket.id).username);
      if (!username) return;
      typingUsers.set(username, socket.id);
      // Broadcast who is typing (server canonical)
      socket.broadcast.emit('typing', { username });
    } catch (error) {
      console.error('Error handling typing:', error);
    }
  });

  socket.on('stop typing', (data) => {
    try {
      const username = sanitizeUsername(data && data.username) || (connectedUsers.get(socket.id) && connectedUsers.get(socket.id).username);
      if (!username) return;
      typingUsers.delete(username);
      socket.broadcast.emit('stop typing', { username });
    } catch (error) {
      console.error('Error handling stop typing:', error);
    }
  });

  socket.on('username changed', (data) => {
    try {
      const newName = sanitizeUsername(data && data.newUsername);
      if (!newName) return;
      const user = connectedUsers.get(socket.id);
      if (!user) return;
      const oldName = user.username;
      user.username = newName;
      connectedUsers.set(socket.id, user);
      io.emit('username changed', { oldName, newName, timestamp: new Date().toISOString() });
      broadcastUserCount();
    } catch (error) {
      console.error('Error handling username changed:', error);
    }
  });

  socket.on('invite to private chat', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) {
        socket.emit('error', { message: 'User not found. Please refresh.' });
        return;
      }

      const { targetUsername } = data;
      if (!targetUsername || targetUsername === userData.username) {
        socket.emit('error', { message: 'Invalid target user' });
        return;
      }

      // Check if target user is online
      const targetUser = Array.from(connectedUsers.values()).find(user => user.username === targetUsername);
      if (!targetUser) {
        socket.emit('error', { message: 'User is not online' });
        return;
      }

      // Get target user's socket
      const targetSocket = io.sockets.sockets.get(targetUser.socketId);
      if (!targetSocket) {
        socket.emit('error', { message: 'User is not available' });
        return;
      }

      // Send invite to target user
      targetSocket.emit('private chat invite', {
        fromUsername: userData.username,
        timestamp: new Date().toISOString()
      });

      // Confirm invite sent to sender
      socket.emit('private chat invite sent', {
        toUsername: targetUsername,
        timestamp: new Date().toISOString()
      });

      console.log(`${userData.username} invited ${targetUsername} to private chat`);
    } catch (error) {
      console.error('Error invite to private chat:', error);
    }
  });

  socket.on('accept private chat', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) {
        socket.emit('error', { message: 'User not found. Please refresh.' });
        return;
      }

      const { fromUsername } = data;
      if (!fromUsername) {
        socket.emit('error', { message: 'Invalid sender' });
        return;
      }

      // Check if sender is still online
      const senderUser = Array.from(connectedUsers.values()).find(user => user.username === fromUsername);
      if (!senderUser) {
        socket.emit('error', { message: 'User is no longer online' });
        return;
      }

      // Create or get private chat
      const chatId = getOrCreatePrivateChat(userData.username, fromUsername);
      
      // Get sender's socket
      const senderSocket = io.sockets.sockets.get(senderUser.socketId);
      if (senderSocket) {
        senderSocket.emit('private chat accepted', {
          byUsername: userData.username,
          chatId: chatId,
          timestamp: new Date().toISOString()
        });
      }

      // Send chat history to both users
      const chat = privateChats.get(chatId);
      if (chat && chat.messages.length > 0) {
        const last20Messages = chat.messages.slice(-20);
        socket.emit('private chat history', {
          chatId: chatId,
          messages: last20Messages,
          withUsername: fromUsername
        });
        
        if (senderSocket) {
          senderSocket.emit('private chat history', {
            chatId: chatId,
            messages: last20Messages,
            withUsername: userData.username
          });
        }
      }

      console.log(`${userData.username} accepted private chat with ${fromUsername}`);
    } catch (error) {
      console.error('Error accepting private chat:', error);
    }
  });

  socket.on('private message', (data) => {
    try {
      // Check rate limit
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded. Please slow down.' });
        return;
      }

      const userData = connectedUsers.get(socket.id);
      if (!userData) {
        socket.emit('error', { message: 'User not found. Please refresh.' });
        return;
      }

      const { chatId, message: messageText, toUsername } = data;
      if (!chatId || !messageText || !toUsername) {
        socket.emit('error', { message: 'Invalid private message data' });
        return;
      }

      const sanitizedMessage = sanitizeMessage(messageText);
      if (!sanitizedMessage) {
        socket.emit('error', { message: 'Invalid message' });
        return;
      }

      // Verify chat exists and user is participant
      const chat = privateChats.get(chatId);
      if (!chat || !chat.participants.has(userData.username) || !chat.participants.has(toUsername)) {
        socket.emit('error', { message: 'Invalid chat room' });
        return;
      }

      const messageData = {
        id: data.id || String(Date.now() + Math.random()),
        username: userData.username,
        message: sanitizedMessage,
        timestamp: new Date().toISOString(),
        reactions: {},
        isPrivate: true
      };

      // Add to private chat history
      addPrivateMessageToHistory(chatId, messageData);

      // Send to both participants
      const targetUser = Array.from(connectedUsers.values()).find(user => user.username === toUsername);
      if (targetUser) {
        const targetSocket = io.sockets.sockets.get(targetUser.socketId);
        if (targetSocket) {
          targetSocket.emit('private message', {
            ...messageData,
            chatId: chatId,
            fromUsername: userData.username
          });
        }
      }

      // Send back to sender for confirmation
      socket.emit('private message', {
        ...messageData,
        chatId: chatId,
        fromUsername: userData.username
      });

      console.log(`Private message from ${userData.username} to ${toUsername}: ${sanitizedMessage}`);
    } catch (error) {
      console.error('Error handling private message:', error);
      socket.emit('error', { message: 'Failed to send private message' });
    }
  });

  socket.on('user leaving', (data) => {
    handleUserDisconnect(socket);
  });

  socket.on("disconnect", (reason) => {
    handleUserDisconnect(socket);
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
  });

  function handleUserDisconnect(socket) {
    try {
      const user = connectedUsers.get(socket.id);
      if (user) {
        const username = user.username;
        connectedUsers.delete(socket.id);
        typingUsers.delete(username);
        io.emit('user left', { username, timestamp: new Date().toISOString() });
        broadcastUserCount();
      }
    } catch (error) {
      console.error('Error during disconnect cleanup:', error);
    }
  }
});

// Clean up old rate limit entries periodically
setInterval(cleanupRateLimits, 300000); // Clean up every 5 minutes

// Periodic TTL pruning for messages (every 5 minutes)
setInterval(() => {
  try {
    pruneExpiredMessages();
  } catch (e) {
    console.error('Error during TTL prune:', e);
  }
}, 300000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Real-time chat server running at http://localhost:${PORT}`);
  console.log(`📱 Users can connect and start chatting!`);
});