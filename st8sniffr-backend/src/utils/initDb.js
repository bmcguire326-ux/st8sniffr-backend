import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/st8sniffr'
});

const initDatabase = async () => {
  try {
    console.log('Initializing database...');

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE,
        password_hash VARCHAR(255),
        username VARCHAR(50) UNIQUE NOT NULL,
        age INTEGER CHECK (age >= 18),
        bio TEXT,
        location_lat DECIMAL(10, 8),
        location_lng DECIMAL(11, 8),
        account_type VARCHAR(20) DEFAULT 'anonymous',
        subscription_status VARCHAR(20) DEFAULT 'none',
        is_subscribed BOOLEAN DEFAULT false,
        stripe_customer_id VARCHAR(100),
        is_nsfw BOOLEAN DEFAULT false,
        is_online BOOLEAN DEFAULT false,
        last_active TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Users table created');

    // Create photos table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        url VARCHAR(500) NOT NULL,
        is_nsfw BOOLEAN DEFAULT false,
        is_profile_picture BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Photos table created');

    // Create messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
        receiver_id UUID REFERENCES users(id) ON DELETE CASCADE,
        content TEXT,
        image_url VARCHAR(500),
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Messages table created');

    // Create subscriptions table for Stripe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        stripe_subscription_id VARCHAR(100) UNIQUE,
        stripe_customer_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'active',
        current_period_start TIMESTAMP,
        current_period_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Subscriptions table created');

    // Create conversations view for easy querying
    await pool.query(`
      CREATE OR REPLACE VIEW conversations AS
      SELECT 
        DISTINCT ON (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
        id,
        sender_id,
        receiver_id,
        content,
        created_at,
        is_read
      FROM messages
      ORDER BY LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC
    `);
    console.log('✓ Conversations view created');

    // Create index for location queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_location 
      ON users(location_lat, location_lng) 
      WHERE account_type != 'anonymous'
    `);
    console.log('✓ Location index created');

    // Create index for online status
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_online 
      ON users(is_online, last_active)
    `);
    console.log('✓ Online status index created');

    console.log('\n✅ Database initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    process.exit(1);
  }
};

initDatabase();
