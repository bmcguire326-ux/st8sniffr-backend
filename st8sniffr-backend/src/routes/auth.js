import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../utils/db.js';
import { generateToken, authenticate } from '../middleware/auth.js';

const router = express.Router();

// Register
router.post('/register', [
  body('username').trim().isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters'),
  body('age').isInt({ min: 18, max: 120 }).withMessage('Age must be 18-120'),
  body('accountType').isIn(['registered', 'anonymous']).withMessage('Invalid account type'),
  body('email').optional().isEmail().withMessage('Invalid email'),
  body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, age, bio, accountType, email, password } = req.body;

    // Check if username exists
    const existingUser = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Check if email exists (for registered accounts)
    if (email) {
      const existingEmail = await query('SELECT id FROM users WHERE email = $1', [email]);
      if (existingEmail.rows.length > 0) {
        return res.status(400).json({ error: 'Email already registered' });
      }
    }

    // Hash password (for registered accounts)
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    // Create user
    const result = await query(
      `INSERT INTO users (username, age, bio, account_type, email, password_hash) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, username, age, bio, account_type, email, subscription_status, is_subscribed, created_at`,
      [username, age, bio || '', accountType, email || null, passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user.id);

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        username: user.username,
        age: user.age,
        bio: user.bio,
        accountType: user.account_type,
        email: user.email,
        subscriptionStatus: user.subscription_status,
        isSubscribed: user.is_subscribed,
        createdAt: user.created_at
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').exists().withMessage('Password required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user
    const result = await query(
      'SELECT id, username, age, bio, account_type, email, password_hash, subscription_status, is_subscribed, is_nsfw, created_at FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update online status
    await query('UPDATE users SET is_online = true, last_active = NOW() WHERE id = $1', [user.id]);

    const token = generateToken(user.id);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        age: user.age,
        bio: user.bio,
        accountType: user.account_type,
        email: user.email,
        subscriptionStatus: user.subscription_status,
        isSubscribed: user.is_subscribed,
        isNSFW: user.is_nsfw,
        createdAt: user.created_at
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Anonymous login (for demo purposes)
router.post('/anonymous', async (req, res) => {
  try {
    // Create anonymous user
    const username = `anon_${Date.now()}`;
    const result = await query(
      `INSERT INTO users (username, age, account_type) 
       VALUES ($1, $2, $3) 
       RETURNING id, username, age, bio, account_type, subscription_status, is_subscribed, created_at`,
      [username, 18, 'anonymous']
    );

    const user = result.rows[0];
    const token = generateToken(user.id);

    res.status(201).json({
      message: 'Anonymous session created',
      user: {
        id: user.id,
        username: user.username,
        age: user.age,
        bio: user.bio,
        accountType: user.account_type,
        subscriptionStatus: user.subscription_status,
        isSubscribed: user.is_subscribed,
        createdAt: user.created_at
      },
      token
    });
  } catch (error) {
    console.error('Anonymous login error:', error);
    res.status(500).json({ error: 'Anonymous login failed' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Update user profile
router.put('/me', authenticate, [
  body('username').optional().trim().isLength({ min: 3, max: 30 }),
  body('bio').optional().trim().isLength({ max: 500 }),
  body('age').optional().isInt({ min: 18, max: 120 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, bio, age } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (username) {
      updates.push(`username = $${paramCount}`);
      values.push(username);
      paramCount++;
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramCount}`);
      values.push(bio);
      paramCount++;
    }
    if (age) {
      updates.push(`age = $${paramCount}`);
      values.push(age);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user.id);

    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} 
       RETURNING id, username, age, bio, account_type, email, subscription_status, is_subscribed`,
      values
    );

    res.json({
      message: 'Profile updated',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    await query('UPDATE users SET is_online = false WHERE id = $1', [req.user.id]);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Upgrade anonymous to registered
router.post('/upgrade', authenticate, [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Check if email exists
    const existingEmail = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.user.id]);
    if (existingEmail.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Update user
    const result = await query(
      `UPDATE users SET account_type = 'registered', email = $1, password_hash = $2 
       WHERE id = $3 
       RETURNING id, username, age, bio, account_type, email, subscription_status, is_subscribed`,
      [email, passwordHash, req.user.id]
    );

    res.json({
      message: 'Account upgraded successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Upgrade error:', error);
    res.status(500).json({ error: 'Upgrade failed' });
  }
});

export default router;
