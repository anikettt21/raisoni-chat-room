# Raisoni Gang Chat App

A real-time chat application built with Node.js, Express, and Socket.IO.

## Features

- Real-time messaging
- User join/leave notifications
- Message reactions
- Typing indicators
- Rate limiting
- Message history (last 50 messages)

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and go to `http://localhost:3000`

## Deployment on Render

### Option 1: Using render.yaml (Recommended)

1. Push your code to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New +" and select "Blueprint"
4. Connect your GitHub repository
5. Render will automatically detect the `render.yaml` file and deploy

### Option 2: Manual Deployment

1. Push your code to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New +" and select "Web Service"
4. Connect your GitHub repository
5. Configure the service:
   - **Name**: raisoni-chat-app
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`

## Environment Variables

- `NODE_ENV`: Set to `production` for production deployment
- `PORT`: Port number (Render will set this automatically)

## Technologies Used

- Node.js
- Express.js
- Socket.IO
- HTML/CSS/JavaScript
