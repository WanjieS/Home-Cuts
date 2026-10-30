# Home-Cuts
A management information system designed for Home Cuts Butchery 

# Butchery & Snack Bar POS & Management System

A hybrid Point of Sale (POS), inventory, and financial reconciliation tool tailored for a Kenyan butchery and snack bar. Built with **Flutter** (Web & Mobile), **Node.js**, and **PostgreSQL**, featuring automated dual-till M-Pesa C2B reconciliation.

---

## 1. Business Logic & Operational Workflows

### A. Dual Product Lines
1. **Butchery (Real-time Transaction Logging):**
   * **Products:** Beef, Mutton, Liver, Kidneys.
   * **Sales Model:** Sold either by exact weight ($kg$) or by custom customer price (e.g., "Meat for $200\text{ KES}$", where weight is auto-calculated as $\frac{\text{Amount}}{\text{Price per kg}}$).
   * **Dine-In Service Fee:** Optional flat **$200\text{ KES}$ Cooking Fee** ("Choma/Fry fee"). Note: This is pure service revenue (zero meat stock deduction, matched against kitchen expenses like charcoal/oil).
2. **Snack Bar (End-of-Day Reconciliation Bypass):**
   * **Products:** Chips, Samosas, Smokies, Sausages.
   * **Sales Model:** Zero individual cash logging during the day to maximize speed during rush hours. Tracked via **End-of-Day (EOD) Reverse Inventory**.

### B. Dual M-Pesa Till Integration (Daraja C2B)
The business operates two distinct Safaricom Buy Goods Till Numbers—one for the **Butchery** and one for **Snacks**. Both rely strictly on **Passive C2B Webhooks** (no STK Push):
* **Meat Till Webhook (`/api/mpesa/c2b/meat`):** When a customer pays the Meat Till, the payment lands in an "Unmatched Meat Payments" queue on the butcher's tablet. The butcher taps the payment to link it to the weighed meat (and optional $200\text{ KES}$ cooking fee).
* **Snack Till Webhook (`/api/mpesa/c2b/snacks`):** When a customer pays the Snack Till, the backend automatically logs and aggregates the transaction into the day's total M-Pesa Snack Revenue—zero action required by the snack vendor.

### C. End-of-Day (EOD) Snack Reconciliation Formula
At closing, the manager enters the **Closing Stock** and **Wastage/Spoiled** count for Samosas, Smokies, and Sausages (and portions/potato weight for Chips). The system automatically calculates expected Cash on Hand using:

$$\text{Units Sold} = \text{Opening Stock} + \text{Restocked} - \text{Closing Stock} - \text{Wastage}$$

$$\text{Total Expected Snack Revenue} = \sum (\text{Units Sold}_i \times \text{Unit Price}_i)$$

$$\text{Expected Snack Cash} = \text{Total Expected Snack Revenue} - \text{Total Snack Till M-Pesa}$$

---

## 2. Hosting Strategy & Infrastructure

Because you are integrating with **Safaricom’s Daraja C2B API**, your Node.js backend **must** be hosted on a public server with a valid **HTTPS (SSL/TLS) certificate** and should **never go to sleep** (free-tier sleeping servers will cause M-Pesa webhooks to time out and drop transactions).

### Recommended Production Hosting Stack

| Component | Recommended Provider | Alternative | Why & Estimated Cost |
| :--- | :--- | :--- | :--- |
| **Node.js Backend** | **Railway.app** or **Render** (Paid Starter) | **DigitalOcean Droplet** or **Hetzner VPS** | **~$5 to $7 / month**. Auto-deploys from GitHub, provides free automatic SSL certificates (required by Safaricom), and stays awake 24/7. |
| **PostgreSQL DB** | **Supabase** or **Neon.tech** | **Railway Postgres** | **Free Tier to $5 / month**. Managed PostgreSQL with automated daily backups and connection pooling. |
| **Flutter Web App** | **Cloudflare Pages** or **Vercel** | **Firebase Hosting** | **$0 (Free)**. Global CDN with instant load times for the manager's web dashboard. |
| **Flutter Mobile App** | **Internal APK / Firebase App Distribution** | **Google Play Store** | **$0 (Free)** for side-loading the `.apk` onto the shop's Android tablets/phones, or a one-time **$25** fee for Google Play. |

### Why this setup works best:
1. **Always-On Webhooks:** If Safaricom sends a C2B payload and your server takes more than a few seconds to wake up, the webhook fails. Paid starter tiers on Railway/Render or a $5 DigitalOcean Ubuntu VPS (running Node via `PM2` and `Nginx` with Let's Encrypt SSL) guarantee 100% webhook capture.
2. **Real-Time UI Updates:** Hosting a persistent Node.js server allows you to use **WebSockets (`Socket.io`)** or **Server-Sent Events (SSE)** so that the moment a customer pays the Meat Till, the payment pops up on the Flutter screen in under 1 second.

---

## 3. Potential Issues & Architectural Solutions (New Rules)

### Issue 1: Cross-Till Payments (Customer Pays the Wrong Till)
* **The Scenario:** A customer buys $500\text{ KES}$ of beef, $200\text{ KES}$ cooking fee, and $150\text{ KES}$ of chips/smokies to eat together, and pays the entire **$850\text{ KES}$** to the **Meat Till** (or accidentally pays the Snack Till for meat).
* **The Fix:** Build a **"Split / Reallocate Till Payment"** button in the Flutter app. If $850\text{ KES}$ hits the Meat Till, the cashier can tag $150\text{ KES}$ of that M-Pesa receipt as "Snack Transfer." This prevents the snack counter from showing a false $150\text{ KES}$ cash surplus at the end of the night.

### Issue 2: The "Chips" Reconciliation Trap
* **The Scenario:** Samosas, smokies, and sausages are discrete countable units (1 piece = 1 unit). **Chips** are made from raw potatoes, which lose weight when peeled and fried, and are scooped by hand into portions.
* **The Fix:** Do not track chips by individual potato fries. Track chips using **Packaging (e.g., Punnet/Boxes or Branded Paper Bags)**. If you hand the snack counter 100 chip boxes in the morning and 30 are left at night, they sold 70 portions of chips.

### Issue 3: Cooking Fee vs. Meat Inventory Distortion
* **The Scenario:** If a customer pays $700\text{ KES}$ ($500\text{ KES}$ Beef + $200\text{ KES}$ Cooking Fee) and the butcher accidentally logs the whole $700\text{ KES}$ as Beef, your system will deduct an extra $200\text{ KES}$ worth of meat from inventory, making it look like the butcher is stealing or over-cutting.
* **The Fix:** In the Flutter POS UI, add a prominent toggle switch on the checkout card: **`[ + Add 200/- Cooking Fee ]`**. In PostgreSQL, store the cooking fee as a `SERVICE` line item so it adds to daily Gross Profit without touching the `meat_inventory` table.

---

## 4. Proposed Database Schema Overview (PostgreSQL)

```sql
-- Core Enums
CREATE TYPE category_type AS ENUM ('MEAT', 'OFFAL', 'SNACK', 'SERVICE');
CREATE TYPE unit_type AS ENUM ('KG', 'PIECE', 'PORTION', 'FLAT_FEE');
CREATE TYPE till_type AS ENUM ('MEAT_TILL', 'SNACK_TILL');

-- 1. Products Table
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL, -- Beef, Mutton, Liver, Kidney, Samosa, Smokie, Sausage, Chips, Cooking Fee
    category category_type NOT NULL,
    unit unit_type NOT NULL,
    buying_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00, -- COGS per unit/kg
    selling_price NUMERIC(10, 2) NOT NULL
);

-- 2. M-Pesa C2B Transactions (Populated automatically via Daraja Webhook)
CREATE TABLE mpesa_transactions (
    id SERIAL PRIMARY KEY,
    trans_id VARCHAR(50) UNIQUE NOT NULL, -- e.g., RKTQDM7W6S
    till_type till_type NOT NULL,
    trans_amount NUMERIC(10, 2) NOT NULL,
    msisdn VARCHAR(20),
    first_name VARCHAR(100),
    is_reconciled BOOLEAN DEFAULT FALSE, -- Used for Meat Till matching
    reallocated_to_snacks NUMERIC(10, 2) DEFAULT 0.00, -- Handles cross-till edge case
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Daily Snack Stock Sheet (For EOD Zero-Entry Bypass)
CREATE TABLE daily_snack_reconciliation (
    id SERIAL PRIMARY KEY,
    business_date DATE NOT NULL,
    product_id INT REFERENCES products(id),
    opening_stock NUMERIC(10, 2) NOT NULL,
    added_stock NUMERIC(10, 2) DEFAULT 0,
    closing_stock NUMERIC(10, 2) NOT NULL,
    wastage NUMERIC(10, 2) DEFAULT 0,
    units_sold NUMERIC(10, 2) GENERATED ALWAYS AS (opening_stock + added_stock - closing_stock - wastage) STORED,
    UNIQUE(business_date, product_id)
);

-- 4. Expenses (Daily & Monthly)
CREATE TABLE expenses (
    id SERIAL PRIMARY KEY,
    title VARCHAR(150) NOT NULL, -- Charcoal, Cooking Oil, Rent, Salaries, Packaging
    category VARCHAR(50) NOT NULL, -- 'DAILY_OPERATIONAL' or 'MONTHLY_FIXED'
    department VARCHAR(50) NOT NULL, -- 'BUTCHERY', 'SNACKS', 'SHARED'
    amount NUMERIC(10, 2) NOT NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE
);
```

---

## 5. Project Structure

```text
butchery-pos/
├── backend/                  # Node.js + Express + PostgreSQL
│   ├── src/
│   │   ├── config/           # DB & Daraja API credentials
│   │   ├── controllers/      # C2B Webhooks, Meat POS, Snack EOD, Expenses
│   │   ├── routes/           # API endpoints
│   │   └── services/         # Profit calculation & Socket.io real-time emitters
│   └── package.json
└── frontend/                 # Flutter (Android, iOS, Web)
    ├── lib/
    │   ├── models/           # Product, Sale, MpesaTransaction, Expense
    │   ├── screens/
    │   │   ├── butcher_pos/  # Fast Meat & 200/- Cooking Fee checkout + Till Queue
    │   │   ├── snack_eod/    # Opening/Closing stock reconciliation form
    │   │   └── dashboard/    # Daily/Monthly Profit & Expense analytics
    │   └── services/         # REST API & WebSocket client
    └── pubspec.yaml
```
