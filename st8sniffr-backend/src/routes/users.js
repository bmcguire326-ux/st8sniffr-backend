import express from 'express';
import { query } from '../utils/db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Get nearby users
router.get('/nearby', authenticate, async (req, res) => {
  try {
    const { lat, lng, radius = 10, limit = 50 } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Latitude and longitude required' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const searchRadius = parseFloat(radius); // km
    const resultLimit = Math.min(parseInt(limit), 100);

    // Haversine formula to calculate distance
    const result = await query(
      `SELECT 
        id, username, age, bio, location_lat, location_lng, 
        account_type, subscription_status, is_subscribed, is_nsfw, is_online, last_active, created_at,
        (6371 * acos(
          cos(radians($1)) * cos(radians(location_lat)) * 
          cos(radians(location_lng) - radians($2)) + 
          sin(radians($1)) * sin(radians(location_lat))
        )) AS distance
      FROM users
      WHERE account_type != 'anonymous'
        AND id != $3
        AND location_lat IS NOT NULL
        AND (6371 * acos(
          cos(radians($1)) * cos(radians(location_lat)) * 
          cos(radians(location_lng) - radians($2)) + 
          sin(radians($1)) * sin(radians(location_lat))
        )) <= $4
      ORDER BY distance
      LIMIT $5`,
      [latitude, longitude, req.user.id, searchRadius, resultLimit]
    );

    // Format response
    const users = result.rows.map(user => ({
      id: user.id,
      username: user.username,
      age: user.age,
      bio: user.bio,
      location: {
        lat: parseFloat(user.location_lat),
        lng: parseFloat(user.location_lng)
      },
      accountType: user.account_type,
      subscriptionStatus: user.subscription_status,
      isSubscribed: user.is_subscribed,
      isNSFW: user.is_nsfw,
      isOnline: user.is_online,
      lastActive: user.last_active,
      distance: Math.round(user.distance * 10) / 10,
      createdAt: user.created_at
    }));

    res.json({ users });
  } catch (error) {
    console.error('Get nearby users error:', error);
    res.status(500).json({ error: 'Failed to get nearby users' });
  }
});

// Get user profile
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT 
        id, username, age, bio, location_lat, location_lng,
        account_type, subscription_status, is_subscribed, is_nsfw, is_online, last_active, created_at
      FROM users
      WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get user's photos
    const photosResult = await query(
      'SELECT id, url, is_nsfw, is_profile_picture, created_at FROM photos WHERE user_id = $1 ORDER BY created_at DESC',
      [id]
    );

    // Format response
    const profile = {
      id: user.id,
      username: user.username,
      age: user.age,
      bio: user.bio,
      location: user.location_lat ? {
        lat: parseFloat(user.location_lat),
        lng: parseFloat(user.location_lng)
      } : null,
      accountType: user.account_type,
      subscriptionStatus: user.subscription_status,
      isSubscribed: user.is_subscribed,
      isNSFW: user.is_nsfw,
      isOnline: user.is_online,
      lastActive: user.last_active,
      createdAt: user.created_at,
      photos: photosResult.rows.map(photo => ({
        id: photo.id,
        url: photo.url,
        isNSFW: photo.is_nsfw,
        isProfilePicture: photo.is_profile_picture,
        createdAt: photo.created_at
      }))
    };

    res.json({ user: profile });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// Update user location
router.post('/location', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude required' });
    }

    await query(
      'UPDATE users SET location_lat = $1, location_lng = $2, last_active = NOW() WHERE id = $3',
      [lat, lng, req.user.id]
    );

    res.json({ message: 'Location updated' });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Update online status
router.post('/online', authenticate, async (req, res) => {
  try {
    const { isOnline } = req.body;

    await query(
      'UPDATE users SET is_online = $1, last_active = NOW() WHERE id = $2',
      [isOnline, req.user.id]
    );

    res.json({ message: 'Online status updated' });
  } catch (error) {
    console.error('Update online status error:', error);
    res.status(500).json({ error: 'Failed to update online status' });
  }
});

// Search users
router.get('/search', authenticate, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const result = await query(
      `SELECT 
        id, username, age, bio, account_type, subscription_status, is_subscribed, is_online
      FROM users
      WHERE account_type != 'anonymous'
        AND (username ILIKE $1 OR bio ILIKE $1)
        AND id != $2
      LIMIT $3`,
      [`%${q}%`, req.user.id, Math.min(parseInt(limit), 50)]
    );

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

export default router;
