import express from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Get user's photos
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, url, is_nsfw, is_profile_picture, created_at FROM photos WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    res.json({ photos: result.rows });
  } catch (error) {
    console.error('Get photos error:', error);
    res.status(500).json({ error: 'Failed to get photos' });
  }
});

// Get photos for a specific user (public endpoint)
router.get('/user/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's account type to determine what photos to show
    const userResult = await query(
      'SELECT account_type, is_nsfw FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = userResult.rows[0];

    // Build query based on viewer's permissions
    let queryText = 'SELECT id, url, is_nsfw, is_profile_picture, created_at FROM photos WHERE user_id = $1';
    const params = [userId];

    // If viewer is anonymous, don't show NSFW photos
    if (req.user.account_type === 'anonymous') {
      queryText += ' AND is_nsfw = false';
    }

    queryText += ' ORDER BY created_at DESC';

    const result = await query(queryText, params);

    res.json({ 
      photos: result.rows,
      isOwner: req.user.id === userId
    });
  } catch (error) {
    console.error('Get user photos error:', error);
    res.status(500).json({ error: 'Failed to get photos' });
  }
});

// Upload photo
router.post('/', authenticate, upload.single('photo'), async (req, res) => {
  try {
    // Check if user is anonymous
    if (req.user.account_type === 'anonymous') {
      // Delete uploaded file
      if (req.file) {
        const fs = await import('fs');
        fs.unlinkSync(req.file.path);
      }
      return res.status(403).json({ 
        error: 'Anonymous users cannot upload photos',
        message: 'Register to upload photos'
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const { isNsfw = 'false', isProfilePicture = 'false' } = req.body;

    // Build file URL
    const fileUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/uploads/${req.file.filename}`;

    const result = await query(
      `INSERT INTO photos (user_id, url, is_nsfw, is_profile_picture) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, url, is_nsfw, is_profile_picture, created_at`,
      [req.user.id, fileUrl, isNsfw === 'true', isProfilePicture === 'true']
    );

    // If this is a profile picture, update user's profile
    if (isProfilePicture === 'true') {
      await query(
        'UPDATE users SET is_nsfw = $1 WHERE id = $2',
        [isNsfw === 'true', req.user.id]
      );
    }

    res.status(201).json({
      message: 'Photo uploaded successfully',
      photo: result.rows[0]
    });
  } catch (error) {
    console.error('Upload photo error:', error);
    // Delete uploaded file on error
    if (req.file) {
      const fs = await import('fs');
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// Delete photo
router.delete('/:photoId', authenticate, async (req, res) => {
  try {
    const { photoId } = req.params;

    // Check if photo exists and belongs to user
    const photo = await query(
      'SELECT user_id, url FROM photos WHERE id = $1',
      [photoId]
    );

    if (photo.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    if (photo.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Can only delete your own photos' });
    }

    // Delete file from disk
    try {
      const fs = await import('fs');
      const filePath = photo.rows[0].url.split('/uploads/')[1];
      if (filePath) {
        fs.unlinkSync(`uploads/${filePath}`);
      }
    } catch (fsError) {
      console.error('File delete error:', fsError);
      // Continue even if file deletion fails
    }

    // Delete from database
    await query('DELETE FROM photos WHERE id = $1', [photoId]);

    res.json({ message: 'Photo deleted' });
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// Update photo (NSFW flag, profile picture)
router.put('/:photoId', authenticate, async (req, res) => {
  try {
    const { photoId } = req.params;
    const { isNsfw, isProfilePicture } = req.body;

    // Check if photo exists and belongs to user
    const photo = await query(
      'SELECT user_id FROM photos WHERE id = $1',
      [photoId]
    );

    if (photo.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    if (photo.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Can only update your own photos' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (isNsfw !== undefined) {
      updates.push(`is_nsfw = $${paramCount}`);
      values.push(isNsfw);
      paramCount++;
    }

    if (isProfilePicture !== undefined) {
      updates.push(`is_profile_picture = $${paramCount}`);
      values.push(isProfilePicture);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(photoId);

    const result = await query(
      `UPDATE photos SET ${updates.join(', ')} WHERE id = $${paramCount} 
       RETURNING id, url, is_nsfw, is_profile_picture, created_at`,
      values
    );

    res.json({
      message: 'Photo updated',
      photo: result.rows[0]
    });
  } catch (error) {
    console.error('Update photo error:', error);
    res.status(500).json({ error: 'Failed to update photo' });
  }
});

export default router;
