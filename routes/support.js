'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');

// Lazy-initialize Stripe so the server starts fine without env vars
let _stripe;
function getStripe() {
  if (!_stripe) {
    const Stripe = require('stripe');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// POST /support/checkout — create a Stripe Checkout session
router.post('/checkout', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required.' });

  try {
    const db   = await getDb();
    const user = await db.get('SELECT is_supporter FROM users WHERE id = ?', req.session.userId);
    if (user?.is_supporter) return res.status(400).json({ error: 'Already a supporter.' });

    const stripe  = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      line_items: [{
        price:    process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/?supported=1`,
      cancel_url:  `${process.env.APP_BASE_URL || 'http://localhost:3000'}/`,
      metadata:    { userId: String(req.session.userId) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// POST /support/webhook — Stripe webhook (raw body applied in server.js before express.json())
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const userId = Number(event.data.object.metadata?.userId);
    if (userId) {
      try {
        const db = await getDb();
        await db.run('UPDATE users SET is_supporter = 1 WHERE id = ?', userId);
        console.log(`User ${userId} marked as supporter.`);
      } catch (err) {
        console.error('Failed to mark supporter:', err.message);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
