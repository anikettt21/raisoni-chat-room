const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, '..')));

// Serve the main HTML file for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'chat.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Chat server is running' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
  
  // Add your socket event handlers here
  socket.on('chat message', (data) => {
    io.emit('chat message', data);
  });
});

// For Vercel serverless functions
module.exports = app;

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
