import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Get conversations for current user
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const result = await query(
      `WITH last_messages AS (
        SELECT DISTINCT ON (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
          id,
          sender_id,
          receiver_id,
          content,
          image_url,
          is_read,
          created_at,
          LEAST(sender_id, receiver_id) as user1,
          GREATEST(sender_id, receiver_id) as user2
        FROM messages
        WHERE sender_id = $1 OR receiver_id = $1
        ORDER BY LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC
      ),
      unread_counts AS (
        SELECT 
          sender_id,
          COUNT(*) as count
        FROM messages
        WHERE receiver_id = $1 AND is_read = false
        GROUP BY sender_id
      )
      SELECT 
        lm.id,
        lm.content,
        lm.image_url,
        lm.is_read,
        lm.created_at,
        CASE 
          WHEN lm.sender_id = $1 THEN lm.receiver_id 
          ELSE lm.sender_id 
        END as other_user_id,
        u.username,
        u.age,
        u.account_type,
        u.subscription_status,
        u.is_subscribed,
        u.is_online,
        u.last_active,
        COALESCE(uc.count, 0) as unread_count
      FROM last_messages lm
      JOIN users u ON u.id = CASE WHEN lm.sender_id = $1 THEN lm.receiver_id ELSE lm.sender_id END
      LEFT JOIN unread_counts uc ON uc.sender_id = CASE WHEN lm.sender_id = $1 THEN lm.receiver_id ELSE lm.sender_id END
      ORDER BY lm.created_at DESC`,
      [req.user.id]
    );

    const conversations = result.rows.map(row => ({
      id: row.id,
      user: {
        id: row.other_user_id,
        username: row.username,
        age: row.age,
        accountType: row.account_type,
        subscriptionStatus: row.subscription_status,
        isSubscribed: row.is_subscribed,
        isOnline: row.is_online,
        lastActive: row.last_active
      },
      lastMessage: {
        content: row.content,
        imageUrl: row.image_url,
        isRead: row.is_read,
        createdAt: row.created_at
      },
      unreadCount: parseInt(row.unread_count),
      updatedAt: row.created_at
    }));

    res.json({ conversations });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// Get messages with a specific user
router.get('/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, before } = req.query;

    let queryText = `
      SELECT 
        id, sender_id, receiver_id, content, image_url, is_read, created_at
      FROM messages
      WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
    `;
    const params = [req.user.id, userId];

    if (before) {
      queryText += ` AND created_at < $3`;
      params.push(before);
    }

    queryText += `
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}
    `;
    params.push(Math.min(parseInt(limit), 100));

    const result = await query(queryText, params);

    // Mark messages as read
    await query(
      'UPDATE messages SET is_read = true WHERE sender_id = $1 AND receiver_id = $2 AND is_read = false',
      [userId, req.user.id]
    );

    const messages = result.rows.reverse().map(msg => ({
      id: msg.id,
      senderId: msg.sender_id,
      receiverId: msg.receiver_id,
      content: msg.content,
      imageUrl: msg.image_url,
      isRead: msg.is_read,
      createdAt: msg.created_at
    }));

    res.json({ messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Send message
router.post('/:userId', authenticate, [
  body('content').optional().trim().isLength({ max: 2000 }).withMessage('Message too long'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.params;
    const { content, imageUrl } = req.body;

    if (!content && !imageUrl) {
      return res.status(400).json({ error: 'Message content or image required' });
    }

    // Check if recipient exists
    const recipient = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (recipient.rows.length === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Check if sender is anonymous and has exceeded message limit
    if (req.user.account_type === 'anonymous') {
      const messageCount = await query(
        'SELECT COUNT(*) FROM messages WHERE sender_id = $1 AND created_at > NOW() - INTERVAL \'1 day\'',
        [req.user.id]
      );
      
      if (parseInt(messageCount.rows[0].count) >= 5) {
        return res.status(403).json({ 
          error: 'Daily message limit reached',
          message: 'Anonymous users are limited to 5 messages per day. Register to send unlimited messages.'
        });
      }
    }

    const result = await query(
      `INSERT INTO messages (sender_id, receiver_id, content, image_url) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, sender_id, receiver_id, content, image_url, is_read, created_at`,
      [req.user.id, userId, content || null, imageUrl || null]
    );

    const message = result.rows[0];

    res.status(201).json({
      message: {
        id: message.id,
        senderId: message.sender_id,
        receiverId: message.receiver_id,
        content: message.content,
        imageUrl: message.image_url,
        isRead: message.is_read,
        createdAt: message.created_at
      }
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Delete message
router.delete('/:messageId', authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;

    // Check if message exists and belongs to user
    const message = await query(
      'SELECT sender_id FROM messages WHERE id = $1',
      [messageId]
    );

    if (message.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (message.rows[0].sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Can only delete your own messages' });
    }

    await query('DELETE FROM messages WHERE id = $1', [messageId]);

    res.json({ message: 'Message deleted' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
