# Raisoni Gang Chat Application

A real-time chat application built with Node.js, Express, Socket.IO, and vanilla JavaScript.

## 🐛 Recent Bug Fixes

### Fixed Issues:
1. **Socket.IO Loading Order**: Moved Socket.IO CDN before main script to prevent timing issues
2. **Username Integration**: Now properly uses saved nicknames from localStorage
3. **Debug Element References**: Removed references to non-existent debug elements
4. **Typing Indicators**: Fixed to work in both connected and local modes
5. **Message Input Auto-resize**: Improved textarea resizing functionality
6. **Server Rate Limiting**: Enhanced cleanup for disconnected users
7. **Error Message Styling**: Added proper animations and positioning
8. **Mobile Responsiveness**: Improved layout for small screens
9. **Username Conflict Resolution**: Added proper handling of username change events
10. **XSS Protection**: Consistent HTML escaping throughout the application

## 🚀 Features

- **Real-time messaging** with Socket.IO
- **User presence indicators** (online/offline status)
- **Typing indicators** showing when users are typing
- **Message history** (last 50 messages)
- **Rate limiting** to prevent spam
- **Responsive design** for mobile and desktop
- **Local mode fallback** when server is unavailable
- **Username persistence** using localStorage
- **Auto-reconnection** with exponential backoff

## 📦 Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in your browser

## 🛠️ Development

For development with auto-restart:
```bash
npm run dev
```

## 📱 Usage

1. **Landing Page** (`index.html`):
   - Enter your nickname (optional)
   - Click "Join Chat" to enter the chat room

2. **Chat Room** (`chat.html`):
   - Type messages in the input field
   - Press Enter or click the send button
   - See real-time updates from other users
   - View typing indicators and user status

## 🔧 Technical Details

### Frontend
- **HTML5**: Semantic markup with proper accessibility
- **CSS3**: Modern styling with animations and responsive design
- **Vanilla JavaScript**: ES6+ features, no frameworks
- **Socket.IO Client**: Real-time communication

### Backend
- **Node.js**: Server runtime
- **Express**: Web framework
- **Socket.IO**: Real-time bidirectional communication
- **Rate Limiting**: Prevents message spam
- **Message Sanitization**: XSS protection

### Security Features
- Input sanitization for messages and usernames
- Rate limiting (10 messages per minute)
- HTML escaping to prevent XSS attacks
- CORS configuration for cross-origin requests

## 🌐 Browser Support

- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## 📄 License

MIT License - see LICENSE file for details

## 👥 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 🐛 Bug Reports

If you find any bugs, please create an issue with:
- Browser and version
- Steps to reproduce
- Expected vs actual behavior
- Console errors (if any)

---

**Made with ❤️ by Aniket Gade**
