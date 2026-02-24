import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import messageRoutes from './routes/messages.js';
import photoRoutes from './routes/photos.js';
import paymentRoutes from './routes/payments.js';

// Import middleware
import { authenticate, verifyToken } from './middleware/auth.js';
import { query } from './utils/db.js';

const app = express();
const httpServer = createServer(app);

// Configure Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Body parsing middleware (except for Stripe webhooks which need raw body)
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Create uploads directory if it doesn't exist
import fs from 'fs';
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/payments', paymentRoutes);

// Socket.io authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const decoded = verifyToken(token);
    const result = await query(
      'SELECT id, username, account_type FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return next(new Error('User not found'));
    }

    socket.userId = result.rows[0].id;
    socket.username = result.rows[0].username;
    socket.accountType = result.rows[0].account_type;
    next();
  } catch (error) {
    console.error('Socket auth error:', error);
    next(new Error('Authentication failed'));
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.username} (${socket.userId})`);

  // Join user's personal room for direct messages
  socket.join(`user:${socket.userId}`);

  // Update user's online status
  query('UPDATE users SET is_online = true, last_active = NOW() WHERE id = $1', [socket.userId]);

  // Broadcast to all users that this user is online
  socket.broadcast.emit('user:online', { userId: socket.userId });

  // Handle joining a chat room
  socket.on('chat:join', (data) => {
    const { userId } = data;
    const roomId = [socket.userId, userId].sort().join('-');
    socket.join(`chat:${roomId}`);
    console.log(`User ${socket.username} joined chat room ${roomId}`);
  });

  // Handle leaving a chat room
  socket.on('chat:leave', (data) => {
    const { userId } = data;
    const roomId = [socket.userId, userId].sort().join('-');
    socket.leave(`chat:${roomId}`);
    console.log(`User ${socket.username} left chat room ${roomId}`);
  });

  // Handle sending a message
  socket.on('message:send', async (data) => {
    try {
      const { receiverId, content, imageUrl } = data;

      // Check if user is anonymous and has exceeded message limit
      if (socket.accountType === 'anonymous') {
        const messageCount = await query(
          'SELECT COUNT(*) FROM messages WHERE sender_id = $1 AND created_at > NOW() - INTERVAL \'1 day\'',
          [socket.userId]
        );
        
        if (parseInt(messageCount.rows[0].count) >= 5) {
          socket.emit('message:error', { 
            error: 'Daily message limit reached',
            message: 'Anonymous users are limited to 5 messages per day. Register to send unlimited messages.'
          });
          return;
        }
      }

      // Save message to database
      const result = await query(
        `INSERT INTO messages (sender_id, receiver_id, content, image_url) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id, sender_id, receiver_id, content, image_url, is_read, created_at`,
        [socket.userId, receiverId, content || null, imageUrl || null]
      );

      const message = result.rows[0];

      // Format message for response
      const messageData = {
        id: message.id,
        senderId: message.sender_id,
        receiverId: message.receiver_id,
        content: message.content,
        imageUrl: message.image_url,
        isRead: message.is_read,
        createdAt: message.created_at
      };

      // Send to sender
      socket.emit('message:sent', messageData);

      // Send to receiver if online
      const roomId = [socket.userId, receiverId].sort().join('-');
      socket.to(`chat:${roomId}`).emit('message:received', messageData);
      
      // Also send to receiver's personal room
      socket.to(`user:${receiverId}`).emit('message:notification', {
        ...messageData,
        senderName: socket.username
      });

      console.log(`Message sent from ${socket.username} to user ${receiverId}`);
    } catch (error) {
      console.error('Socket message error:', error);
      socket.emit('message:error', { error: 'Failed to send message' });
    }
  });

  // Handle typing indicator
  socket.on('typing:start', (data) => {
    const { userId } = data;
    const roomId = [socket.userId, userId].sort().join('-');
    socket.to(`chat:${roomId}`).emit('typing:start', { userId: socket.userId });
  });

  socket.on('typing:stop', (data) => {
    const { userId } = data;
    const roomId = [socket.userId, userId].sort().join('-');
    socket.to(`chat:${roomId}`).emit('typing:stop', { userId: socket.userId });
  });

  // Handle location update
  socket.on('location:update', async (data) => {
    try {
      const { lat, lng } = data;
      
      await query(
        'UPDATE users SET location_lat = $1, location_lng = $2, last_active = NOW() WHERE id = $3',
        [lat, lng, socket.userId]
      );

      // Broadcast location update to nearby users (simplified)
      socket.broadcast.emit('user:location', { 
        userId: socket.userId, 
        lat, 
        lng 
      });
    } catch (error) {
      console.error('Location update error:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.username} (${socket.userId})`);
    
    // Update user's online status
    await query('UPDATE users SET is_online = false, last_active = NOW() WHERE id = $1', [socket.userId]);
    
    // Broadcast to all users that this user is offline
    socket.broadcast.emit('user:offline', { userId: socket.userId });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🚀 St8sniffr Backend Server                            ║
║                                                          ║
║   Running on port: ${PORT}                                ║
║   Environment: ${process.env.NODE_ENV || 'development'}                    ║
║   Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}  ║
║                                                          ║
║   API Endpoints:                                         ║
║   • POST /api/auth/register                              ║
║   • POST /api/auth/login                                 ║
║   • GET  /api/users/nearby                               ║
║   • GET  /api/messages/conversations                     ║
║   • POST /api/payments/create-subscription               ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

export default app;
