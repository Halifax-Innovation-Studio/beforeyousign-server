-- Migration: 001_users_table.sql
-- Phase 1 Premium subscription
-- Apply to: beforeyousign-server database
-- Run once before deploying subscription routes.

CREATE TABLE IF NOT EXISTS users (
  id                            UUID          PRIMARY KEY,
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  subscription_status           TEXT          NOT NULL DEFAULT 'none'
                                              CHECK (subscription_status IN (
                                                'none', 'active', 'expired',
                                                'grace', 'billing_retry'
                                              )),
  subscription_product_id       TEXT,
  subscription_expires_at       TIMESTAMPTZ,
  apple_original_transaction_id TEXT          UNIQUE,
  last_verified_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_apple_otid
  ON users (apple_original_transaction_id)
  WHERE apple_original_transaction_id IS NOT NULL;
