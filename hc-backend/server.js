require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (!process.env.DATABASE_URL) {
  console.error("CRITICAL ERROR: DATABASE_URL is missing from .env file!");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==========================================
// 1. PRODUCTS & INVENTORY BATCHES
// ==========================================

// Get all products + current available stock
app.get('/api/products', async (req, res) => {
  try {
    const query = `
      SELECT p.*, 
             COALESCE(SUM(b.remaining_quantity) FILTER (WHERE b.is_exhausted = FALSE), 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_batches b ON p.id = b.product_id
      GROUP BY p.id
      ORDER BY p.id ASC;
    `;
    const result = await pool.query(query);
    res.json({ status: 'Connected', products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log a Stock Batch Purchase (Raw Meat Carcass, Offal, Packet Sausages/Smokies)
app.post('/api/batches', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { product_id, raw_quantity, shrinkage_pct, total_batch_cost, paid_via, description } = req.body;
    
    const sellable_qty = Number(raw_quantity) * (1 - ((Number(shrinkage_pct) || 0) / 100));

    const batchRes = await client.query(
      `INSERT INTO inventory_batches 
       (product_id, raw_quantity, shrinkage_pct, remaining_quantity, total_batch_cost)
       VALUES ($1::int, $2::numeric, $3::numeric, $4::numeric, $5::numeric) RETURNING *`,
      [product_id, raw_quantity, shrinkage_pct || 0, sellable_qty, total_batch_cost]
    );

    await client.query(
      `INSERT INTO cash_outflow_ledger (bucket, description, amount_paid, paid_via, reference_id)
       VALUES ('STOCK_PURCHASE', $1, $2::numeric, $3, $4)`,
      [description || 'Stock Batch Purchase', total_batch_cost, paid_via || 'CASH', batchRes.rows[0].id]
    );

    await client.query('COMMIT');
    res.json({ message: 'New stock added successfully', batch: batchRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 2. SAMOSA IN-HOUSE PRODUCTION RUNS
// ==========================================

app.post('/api/samosa-production', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { minced_meat_cost, flour_cost, onions_spices_cost, pieces_folded, paid_via } = req.body;

    // Find Samosa product_id
    const prodRes = await client.query(`SELECT id FROM products WHERE name = 'Samosa' LIMIT 1`);
    if (prodRes.rows.length === 0) throw new Error("Samosa is not set up in the system.");
    const samosaProductId = prodRes.rows[0].id;

    const totalCost = Number(minced_meat_cost || 0) + Number(flour_cost || 0) + Number(onions_spices_cost || 0);

    // 1. Create an inventory batch for the folded samosas
    const batchRes = await client.query(
      `INSERT INTO inventory_batches (product_id, raw_quantity, shrinkage_pct, remaining_quantity, total_batch_cost)
       VALUES ($1::int, $2::numeric, 0, $2::numeric, $3::numeric) RETURNING *`,
      [samosaProductId, pieces_folded, totalCost]
    );

    // 2. Record the samosa production breakdown
    const runRes = await client.query(
      `INSERT INTO samosa_production_runs 
       (minced_meat_cost, flour_cost, onions_spices_cost, pieces_folded, inventory_batch_id)
       VALUES ($1::numeric, $2::numeric, $3::numeric, $4::int, $5) RETURNING *`,
      [minced_meat_cost || 0, flour_cost || 0, onions_spices_cost || 0, pieces_folded, batchRes.rows[0].id]
    );

    // 3. Log cash outflow for the ingredients
    await client.query(
      `INSERT INTO cash_outflow_ledger (bucket, description, amount_paid, paid_via, reference_id)
       VALUES ('SAMOSA_BATCH', $1, $2::numeric, $3, $4)`,
      [`Samosa Batch (${pieces_folded} pcs)`, totalCost, paid_via || 'CASH', runRes.rows[0].id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Samosa batch saved successfully', production_run: runRes.rows[0], batch: batchRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 3. CONSUMABLES (OIL, GAS, POTATOES) & OVERHEADS
// ==========================================

app.post('/api/consumables', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { item_name, total_cost, expected_days, paid_via } = req.body;

    // If an active cycle for this same item (e.g., 'Cooking Oil') is still running, close it yesterday
    await client.query(
      `UPDATE consumable_cycles 
       SET end_date = CURRENT_DATE - INTERVAL '1 day', is_active = FALSE
       WHERE item_name = $1 AND is_active = TRUE AND end_date >= CURRENT_DATE`,
      [item_name]
    );

    // Insert new consumable cycle
    const cycleRes = await client.query(
      `INSERT INTO consumable_cycles (item_name, total_cost, expected_days, start_date, end_date)
       VALUES ($1, $2::numeric, $3::int, CURRENT_DATE, CURRENT_DATE + ($3::int - 1) * INTERVAL '1 day') RETURNING *`,
      [item_name, total_cost, expected_days]
    );

    // Record cash outflow
    await client.query(
      `INSERT INTO cash_outflow_ledger (bucket, description, amount_paid, paid_via, reference_id)
       VALUES ('CONSUMABLE', $1, $2::numeric, $3, $4)`,
      [`${item_name} (${expected_days} days est.)`, total_cost, paid_via || 'CASH', cycleRes.rows[0].id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Item cost saved and spread across days', consumable: cycleRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Set Monthly Rent & Electricity Budget
app.post('/api/overheads/config', async (req, res) => {
  try {
    const { month_year, rent_budget, electricity_budget, days_in_month } = req.body;
    const result = await pool.query(
      `INSERT INTO monthly_overhead_configs (month_year, rent_budget, electricity_budget, days_in_month)
       VALUES ($1, $2::numeric, $3::numeric, $4::int)
       ON CONFLICT (month_year) DO UPDATE 
       SET rent_budget = EXCLUDED.rent_budget, electricity_budget = EXCLUDED.electricity_budget, days_in_month = EXCLUDED.days_in_month
       RETURNING *`,
      [month_year, rent_budget, electricity_budget, days_in_month || 30]
    );
    res.json({ message: 'Monthly rent and electricity budget saved', config: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. MEAT POS SALE (Supports arbitrary price e.g. "Beef for 200/-" & FIFO COGS)
// ==========================================

app.post('/api/pos/sale', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { items, payments } = req.body;

    const totalOrderAmount = payments.reduce((sum, p) => sum + Number(p.amount), 0);

    const orderRes = await client.query(
      `INSERT INTO pos_orders (total_amount) VALUES ($1::numeric) RETURNING *`,
      [totalOrderAmount]
    );
    const orderId = orderRes.rows[0].id;

    for (const item of items) {
      const prodRes = await client.query(`SELECT * FROM products WHERE id = $1::int`, [item.product_id]);
      const product = prodRes.rows[0];

      // Handle Service items like 200 KES Cooking Fee (No inventory batch or COGS)
      if (product.unit === 'SERVICE') {
        await client.query(
          `INSERT INTO pos_order_items (order_id, product_id, quantity, revenue, cogs)
           VALUES ($1, $2::int, 1, $3::numeric, 0)`,
          [orderId, product.id, item.revenue_amount || product.selling_price]
        );
        continue;
      }

      // Calculate exact weight & revenue whether sold by weight (e.g., 0.5kg) or custom price (e.g., 200 KES)
      const sellingPrice = Number(product.selling_price);
      const quantityNeeded = item.weight_kg 
        ? Number(item.weight_kg) 
        : Number((Number(item.revenue_amount) / sellingPrice).toFixed(3));
      const itemRevenue = item.revenue_amount 
        ? Number(item.revenue_amount) 
        : Number((quantityNeeded * sellingPrice).toFixed(2));

      // Fetch oldest active inventory batches (FIFO)
      const batchesRes = await client.query(
        `SELECT * FROM inventory_batches 
         WHERE product_id = $1::int AND is_exhausted = FALSE AND remaining_quantity > 0
         ORDER BY purchase_date ASC, created_at ASC FOR UPDATE`,
        [product.id]
      );

      let remainingToFulfill = quantityNeeded;

      for (const batch of batchesRes.rows) {
        if (remainingToFulfill <= 0) break;
        const available = Number(batch.remaining_quantity);
        const deductQty = Math.min(available, remainingToFulfill);
        const portionRevenue = Number(((deductQty / quantityNeeded) * itemRevenue).toFixed(2));
        const portionCogs = Number((deductQty * Number(batch.unit_cost)).toFixed(2));

        await client.query(
          `INSERT INTO pos_order_items (order_id, product_id, batch_id, quantity, revenue, cogs)
           VALUES ($1, $2::int, $3, $4::numeric, $5::numeric, $6::numeric)`,
          [orderId, product.id, batch.id, deductQty, portionRevenue, portionCogs]
        );

        const newRemaining = Number((available - deductQty).toFixed(3));
        await client.query(
          `UPDATE inventory_batches SET remaining_quantity = $1::numeric, is_exhausted = ($1::numeric <= 0) WHERE id = $2`,
          [newRemaining, batch.id]
        );

        remainingToFulfill = Number((remainingToFulfill - deductQty).toFixed(3));
      }

      if (remainingToFulfill > 0) {
        throw new Error(`Not enough ${product.name} in stock right now. You are short by ${remainingToFulfill} ${product.unit}. Please add new stock first.`);
      }
    }

    // Record Payments & Match M-Pesa Receipt if applicable
    for (const pay of payments) {
      await client.query(
        `INSERT INTO pos_order_payments (order_id, payment_type, amount, mpesa_receipt)
         VALUES ($1, $2, $3::numeric, $4)`,
        [orderId, pay.payment_type, pay.amount, pay.mpesa_receipt || null]
      );

      if (pay.mpesa_receipt) {
        await client.query(
          `UPDATE mpesa_c2b_transactions SET is_matched_to_pos = TRUE WHERE mpesa_receipt = $1`,
          [pay.mpesa_receipt]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Sale recorded successfully', order_id: orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 5. END-OF-DAY (EOD) SNACK RECONCILIATION
// ==========================================

app.post('/api/snacks/reconcile', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { product_id, opening_stock, added_stock, closing_stock, wastage_or_spoiled } = req.body;

    const prodRes = await client.query(`SELECT * FROM products WHERE id = $1::int`, [product_id]);
    const product = prodRes.rows[0];

    // Get latest active batch for unit_cost
    const batchRes = await client.query(
      `SELECT * FROM inventory_batches WHERE product_id = $1::int AND is_exhausted = FALSE ORDER BY created_at DESC LIMIT 1`,
      [product_id]
    );
    const activeBatch = batchRes.rows[0];
    const unitBatchCost = activeBatch ? Number(activeBatch.unit_cost) : 0;

    const reconRes = await client.query(
      `INSERT INTO eod_snack_reconciliations 
       (product_id, batch_id, opening_stock, added_stock, closing_stock, wastage_or_spoiled, unit_selling_price, unit_batch_cost)
       VALUES ($1::int, $2, $3::int, $4::int, $5::int, $6::int, $7::numeric, $8::numeric)
       ON CONFLICT (recon_date, product_id) DO UPDATE
       SET opening_stock = EXCLUDED.opening_stock, added_stock = EXCLUDED.added_stock,
           closing_stock = EXCLUDED.closing_stock, wastage_or_spoiled = EXCLUDED.wastage_or_spoiled
       RETURNING *`,
      [product_id, activeBatch ? activeBatch.id : null, opening_stock, added_stock || 0, closing_stock, wastage_or_spoiled || 0, product.selling_price, unitBatchCost]
    );

    // Update batch remaining stock
    if (activeBatch) {
      await client.query(
        `UPDATE inventory_batches SET remaining_quantity = $1::numeric, is_exhausted = ($1::numeric <= 0) WHERE id = $2`,
        [closing_stock, activeBatch.id]
      );
    }

    await client.query('COMMIT');
    res.json({ message: `${product.name} daily count saved`, reconciliation: reconRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 6. SAFARICOM DARAJA C2B INTEGRATION
// ==========================================

const DARAJA_BASE_URL = process.env.DARAJA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Helper: Generate Daraja OAuth Access Token
async function getDarajaToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString('base64');

  const response = await fetch(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`Daraja Auth Failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// 6A. Register Confirmation & Validation URLs with Safaricom (Run once per Till)
app.post('/api/payments/register-urls', async (req, res) => {
  try {
    const token = await getDarajaToken();
    const shortcode = req.body.shortcode || process.env.MPESA_MEAT_TILL || '201039';
    const publicBase = process.env.PUBLIC_BASE_URL || 'https://home-cuts.onrender.com';

    // NOTE: URL paths must NOT contain the word "mpesa" or Safaricom will reject them!
    const payload = {
      ShortCode: String(shortcode),
      ResponseType: 'Completed',
      ConfirmationURL: `${publicBase}/api/payments/confirm`,
      ValidationURL: `${publicBase}/api/payments/validate`
    };

    const response = await fetch(`${DARAJA_BASE_URL}/mpesa/c2b/v1/registerurl`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    res.json({ shortcode, daraja_response: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6B. Validation URL (Safaricom checks this before completing payment)
const handleValidate = (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
};
app.post('/api/payments/validate', handleValidate);
app.post('/api/mpesa/c2b-validation', handleValidate);

// 6C. Confirmation URL (Safaricom sends instant payment data here)
const handleConfirm = async (req, res) => {
  try {
    const { TransID, TransAmount, BusinessShortCode, MSISDN, FirstName, MiddleName, LastName } = req.body;
    const customerName = [FirstName, MiddleName, LastName].filter(Boolean).join(' ');

    const snackTill = process.env.MPESA_SNACK_TILL || '9387337';
    const tillCategory = (String(BusinessShortCode) === String(snackTill))
      ? 'SNACK'
      : 'MEAT';

    await pool.query(
      `INSERT INTO mpesa_c2b_transactions (mpesa_receipt, till_category, trans_time, amount, customer_phone, customer_name)
       VALUES ($1, $2, NOW(), $3::numeric, $4, $5) ON CONFLICT (mpesa_receipt) DO NOTHING`,
      [TransID, tillCategory, TransAmount, MSISDN, customerName]
    );

    console.log(`✅ Till Payment Recorded: ${TransID} - ${TransAmount} KES (${tillCategory})`);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Webhook Error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
};
app.post('/api/payments/confirm', handleConfirm);
app.post('/api/mpesa/c2b-confirmation', handleConfirm);

// 6D. Fetch Unmatched Meat Till Payments (For Cashier 1-Tap Matching Queue)
app.get('/api/mpesa/unmatched-meat', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM mpesa_c2b_transactions 
       WHERE till_category = 'MEAT' AND is_matched_to_pos = FALSE AND trans_date = CURRENT_DATE
       ORDER BY trans_time DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6E. Daily Profit & Cash Flow Summary
app.get('/api/dashboard/today', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM daily_financial_summary WHERE report_date = CURRENT_DATE`
    );
    res.json(result.rows[0] || {
      report_date: new Date().toISOString().split('T')[0],
      total_daily_revenue: 0,
      true_daily_net_profit: 0,
      net_cash_flow_today: 0,
      message: 'No sales recorded yet today.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6F. Simulate a C2B Till Payment via Daraja Sandbox API
app.post('/api/payments/simulate-daraja', async (req, res) => {
  try {
    const token = await getDarajaToken();
    const { shortcode, amount, phone } = req.body;

    const payload = {
      ShortCode: shortcode || process.env.MPESA_MEAT_TILL || '201039',
      CommandID: 'CustomerBuyGoodsOnline',
      Amount: amount || 200,
      Msisdn: phone || '254708374149'
    };

    const response = await fetch(`${DARAJA_BASE_URL}/mpesa/c2b/v1/simulate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'active', timestamp: new Date() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Butchery Server running on http://localhost:${PORT}`);
});
