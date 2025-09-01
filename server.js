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
const recentMessages = []; // Store last 50 messages
const MAX_MESSAGES = 50;
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
  
  // Keep only recent messages
  if (recentMessages.length > MAX_MESSAGES) {
    recentMessages.shift();
  }
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
        console.log(`Removed existing reaction ${existingReaction} by ${username} from message ${messageId}`);
        
        // Remove reaction if no users left
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
      console.log(`Added reaction ${reaction} by ${username} to message ${messageId}`);
    }
  } else if (action === 'remove') {
    // Remove user from specific reaction
    if (message.reactions[reaction]) {
      const index = message.reactions[reaction].indexOf(username);
      if (index > -1) {
        message.reactions[reaction].splice(index, 1);
        console.log(`Removed reaction ${reaction} by ${username} from message ${messageId}`);
      }
      
      // Remove reaction if no users left
      if (message.reactions[reaction].length === 0) {
        delete message.reactions[reaction];
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

// Private chat helper functions
function createPrivateChatId(user1, user2) {
  // Create a consistent chat ID regardless of who initiates
  const sortedUsers = [user1, user2].sort();
  return `private_${sortedUsers[0]}_${sortedUsers[1]}`;
}

function getOrCreatePrivateChat(user1, user2) {
  const chatId = createPrivateChatId(user1, user2);
  
  if (!privateChats.has(chatId)) {
    privateChats.set(chatId, {
      participants: new Set([user1, user2]),
      messages: []
    });
  }
  
  // Ensure both users are tracked as having this private chat
  if (!userPrivateChats.has(user1)) {
    userPrivateChats.set(user1, new Set());
  }
  if (!userPrivateChats.has(user2)) {
    userPrivateChats.set(user2, new Set());
  }
  
  userPrivateChats.get(user1).add(chatId);
  userPrivateChats.get(user2).add(chatId);
  
  return chatId;
}

function addPrivateMessageToHistory(chatId, messageData) {
  const chat = privateChats.get(chatId);
  if (!chat) return false;
  
  // Initialize reactions if not present
  if (!messageData.reactions) {
    messageData.reactions = {};
  }
  
  // Ensure message has a unique ID as string
  if (!messageData.id) {
    messageData.id = String(Date.now() + Math.random());
  }
  
  chat.messages.push({
    ...messageData,
    id: String(messageData.id)
  });
  
  // Keep only recent messages
  if (chat.messages.length > MAX_PRIVATE_MESSAGES) {
    chat.messages.shift();
  }
  
  return true;
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Send recent messages to newly connected user
  if (recentMessages.length > 0) {
    const last10Messages = recentMessages.slice(-10);
    last10Messages.forEach(msg => {
      // Ensure reactions are included when sending to new users
      const messageWithReactions = {
        ...msg,
        reactions: msg.reactions || {}
      };
      socket.emit('chat message', messageWithReactions);
    });
  }

  socket.on('user joined', (data) => {
    try {
      const username = sanitizeUsername(data.username);
      if (!username) {
        socket.emit('error', { message: 'Invalid username' });
        return;
      }

      // Check if username is already taken
      const existingUser = Array.from(connectedUsers.values()).find(user => user.username === username);
      if (existingUser && existingUser.socketId !== socket.id) {
        const newUsername = `${username}_${Math.floor(Math.random() * 1000)}`;
        socket.emit('username changed', { 
          oldUsername: username, 
          newUsername: newUsername,
          reason: 'Username already taken'
        });
        connectedUsers.set(socket.id, { username: newUsername, socketId: socket.id, joinTime: new Date() });
      } else {
        connectedUsers.set(socket.id, { username, socketId: socket.id, joinTime: new Date() });
      }

      const userData = connectedUsers.get(socket.id);
      
      // Broadcast user joined (except to the user themselves)
      socket.broadcast.emit('user joined', {
        username: userData.username,
        timestamp: new Date().toISOString()
      });

      // Send current online users to the new user immediately
      const onlineUsers = getOnlineUsers();
      socket.emit('online users', onlineUsers);
      
      // Broadcast updated user count and online users list to all clients
      broadcastUserCount();
      
      console.log(`${userData.username} joined the chat. Total users: ${connectedUsers.size}`);
    } catch (error) {
      console.error('Error handling user join:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  // Handle explicit request for online users (for modal)
  socket.on('get online users', () => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) {
        socket.emit('error', { message: 'User not found. Please refresh.' });
        return;
      }
      
      const onlineUsers = getOnlineUsers();
      console.log(`Sending online users to ${userData.username}: ${onlineUsers.join(', ')}`);
      
      // Send the current online users list to this specific client
      socket.emit('online users', onlineUsers);
    } catch (error) {
      console.error('Error getting online users:', error);
      socket.emit('error', { message: 'Failed to get online users' });
    }
  });

  socket.on("chat message", (data) => {
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

      const sanitizedMessage = sanitizeMessage(data.message);
      if (!sanitizedMessage) {
        socket.emit('error', { message: 'Invalid message' });
        return;
      }

      const messageData = {
        id: data.id || String(Date.now() + Math.random()),
        username: userData.username,
        message: sanitizedMessage,
        timestamp: new Date().toISOString(),
        reactions: {}
      };

      // Add to message history
      addMessageToHistory(messageData);

      // Broadcast to all clients with reactions included
      io.emit("chat message", messageData);
      
      console.log(`${userData.username}: ${sanitizedMessage} (ID: ${messageData.id})`);
    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('message reaction', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) {
        socket.emit('error', { message: 'User not found. Please refresh.' });
        return;
      }

      const { messageId, reaction, action } = data;
      
      if (!messageId || !reaction || !action) {
        socket.emit('error', { message: 'Invalid reaction data' });
        return;
      }

      console.log(`Processing reaction: ${action} ${reaction} on message ${messageId} by ${userData.username}`);

      // Update message reactions in history
      const success = updateMessageReactions(messageId, reaction, userData.username, action);
      
      if (success) {
        // Broadcast reaction update to all clients
        io.emit('message reaction', {
          messageId: messageId,
          reaction: reaction,
          username: userData.username,
          action: action
        });
        
        console.log(`Broadcasted reaction: ${userData.username} ${action}ed ${reaction} on message ${messageId}`);
      } else {
        socket.emit('error', { message: 'Message not found' });
      }
    } catch (error) {
      console.error('Error handling reaction:', error);
      socket.emit('error', { message: 'Failed to add reaction' });
    }
  });

  socket.on('typing', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) return;

      typingUsers.set(userData.username, socket.id);
      socket.broadcast.emit('user typing', { username: userData.username });
    } catch (error) {
      console.error('Error handling typing:', error);
    }
  });

  socket.on('stop typing', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) return;

      typingUsers.delete(userData.username);
      socket.broadcast.emit('user stop typing', { username: userData.username });
    } catch (error) {
      console.error('Error handling stop typing:', error);
    }
  });

  socket.on('username changed', (data) => {
    try {
      const userData = connectedUsers.get(socket.id);
      if (!userData) return;

      const newUsername = sanitizeUsername(data.newUsername);
      if (!newUsername) {
        socket.emit('error', { message: 'Invalid new username' });
        return;
      }

      // Check if new username is available
      const existingUser = Array.from(connectedUsers.values()).find(user => 
        user.username === newUsername && user.socketId !== socket.id
      );
      
      if (existingUser) {
        socket.emit('error', { message: 'Username already taken' });
        return;
      }

      const oldUsername = userData.username;
      userData.username = newUsername;
      
      // Remove from typing users if was typing
      if (typingUsers.has(oldUsername)) {
        typingUsers.delete(oldUsername);
        typingUsers.set(newUsername, socket.id);
      }

      // Broadcast username change
      io.emit('user joined', {
        username: newUsername,
        timestamp: new Date().toISOString()
      });

      // Update online users list for all clients
      broadcastUserCount();

      console.log(`${oldUsername} changed username to ${newUsername}`);
    } catch (error) {
      console.error('Error handling username change:', error);
    }
  });

  // Private chat events
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
      console.error('Error sending private chat invite:', error);
      socket.emit('error', { message: 'Failed to send invite' });
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
      socket.emit('error', { message: 'Failed to accept private chat' });
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
      const userData = connectedUsers.get(socket.id);
      if (userData) {
        // Remove from typing users
        typingUsers.delete(userData.username);
        
        // Broadcast user left
        socket.broadcast.emit('user left', {
          username: userData.username,
          timestamp: new Date().toISOString()
        });
        
        // Remove from connected users
        connectedUsers.delete(socket.id);
        
        // Broadcast updated user count and online users list
        broadcastUserCount();
        
        console.log(`${userData.username} left the chat. Remaining users: ${connectedUsers.size}`);
      }

      // Clean up rate limiting for this user
      messageLimits.delete(socket.id);
    } catch (error) {
      console.error('Error handling user disconnect:', error);
    }
  }
});

// Clean up old rate limit entries periodically
setInterval(cleanupRateLimits, 300000); // Clean up every 5 minutes

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