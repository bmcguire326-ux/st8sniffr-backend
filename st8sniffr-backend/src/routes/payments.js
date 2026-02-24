import express from 'express';
import Stripe from 'stripe';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID; // Your $4.99/month price ID
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Create checkout session for subscription
router.post('/create-subscription', authenticate, async (req, res) => {
  try {
    // Only registered users can subscribe
    if (req.user.account_type !== 'registered') {
      return res.status(403).json({ 
        error: 'Only registered users can subscribe',
        message: 'Please register your account before subscribing'
      });
    }

    // Check if user already has an active subscription
    if (req.user.is_subscribed) {
      return res.status(400).json({ 
        error: 'Already subscribed',
        message: 'You already have an active subscription'
      });
    }

    let customerId = req.user.stripe_customer_id;

    // Create Stripe customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: {
          userId: req.user.id
        }
      });
      customerId = customer.id;

      // Save customer ID to database
      await query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, req.user.id]
      );
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment-cancelled`,
      metadata: {
        userId: req.user.id
      },
      subscription_data: {
        metadata: {
          userId: req.user.id
        }
      }
    });

    res.json({ 
      url: session.url 
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Get subscription status
router.get('/status', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        s.stripe_subscription_id,
        s.status,
        s.current_period_start,
        s.current_period_end,
        u.is_subscribed,
        u.subscription_status
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ 
        isSubscribed: false,
        status: 'none'
      });
    }

    const subscription = result.rows[0];

    res.json({
      isSubscribed: subscription.is_subscribed,
      status: subscription.subscription_status,
      stripeStatus: subscription.status,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end
    });
  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// Cancel subscription
router.post('/cancel', authenticate, async (req, res) => {
  try {
    if (!req.user.is_subscribed) {
      return res.status(400).json({ error: 'No active subscription' });
    }

    // Get subscription from database
    const result = await query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = $2',
      [req.user.id, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const stripeSubscriptionId = result.rows[0].stripe_subscription_id;

    // Cancel at period end (user keeps access until end of billing period)
    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    // Update database
    await query(
      'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
      ['canceling', stripeSubscriptionId]
    );

    res.json({ 
      message: 'Subscription will be cancelled at the end of the billing period'
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Resume subscription (if user cancelled but wants to reactivate)
router.post('/resume', authenticate, async (req, res) => {
  try {
    // Get subscription from database
    const result = await query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = $2',
      [req.user.id, 'canceling']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No cancelling subscription found' });
    }

    const stripeSubscriptionId = result.rows[0].stripe_subscription_id;

    // Resume subscription
    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    // Update database
    await query(
      'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
      ['active', stripeSubscriptionId]
    );

    res.json({ 
      message: 'Subscription resumed successfully'
    });
  } catch (error) {
    console.error('Resume subscription error:', error);
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

// Create customer portal session (for managing payment methods, etc.)
router.post('/portal', authenticate, async (req, res) => {
  try {
    if (!req.user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Create portal session error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Webhook handler (Stripe sends events here)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    // Verify webhook signature
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, WEBHOOK_SECRET);
  } catch (error) {
    console.error('Webhook signature verification failed:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  console.log('Webhook received:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const subscriptionId = session.subscription;
        const customerId = session.customer;

        // Get subscription details from Stripe
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        // Save subscription to database
        await query(
          `INSERT INTO subscriptions 
           (user_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end)
           VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))`,
          [
            userId,
            subscriptionId,
            customerId,
            subscription.status,
            subscription.current_period_start,
            subscription.current_period_end
          ]
        );

        // Update user's subscription status
        await query(
          'UPDATE users SET subscription_status = $1, is_subscribed = true WHERE id = $2',
          ['active', userId]
        );

        console.log(`Subscription created for user ${userId}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (subscriptionId) {
          // Update subscription period
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          
          await query(
            `UPDATE subscriptions 
             SET current_period_start = to_timestamp($1), 
                 current_period_end = to_timestamp($2),
                 status = $3
             WHERE stripe_subscription_id = $4`,
            [
              subscription.current_period_start,
              subscription.current_period_end,
              subscription.status,
              subscriptionId
            ]
          );
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (subscriptionId) {
          // Update subscription status
          await query(
            'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
            ['past_due', subscriptionId]
          );

          // Get user ID
          const result = await query(
            'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
            [subscriptionId]
          );

          if (result.rows.length > 0) {
            await query(
              'UPDATE users SET subscription_status = $1 WHERE id = $2',
              ['past_due', result.rows[0].user_id]
            );
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        // Update subscription status
        await query(
          'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
          ['cancelled', subscriptionId]
        );

        // Get user ID
        const result = await query(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
          [subscriptionId]
        );

        if (result.rows.length > 0) {
          await query(
            'UPDATE users SET subscription_status = $1, is_subscribed = false WHERE id = $2',
            ['none', result.rows[0].user_id]
          );
        }

        console.log(`Subscription ${subscriptionId} cancelled`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
