# ROOMI CAFE — Complete Restaurant POS & Management System

> **A professional, robust, and offline-capable Point of Sale and Restaurant Management System engineered specifically for Pakistani food & cafe operations.**  
> Supports Pakistani Rupees (PKR), Urdu/English bilingual menus, recipe-based stock deductions, customer Udhaar (credit) ledgers, 80mm/58mm thermal receipts, and separate Kitchen Order Tickets (KOT) per preparation station.

---

## 1. System Overview & Key Capabilities

- **Bilingual Menu & Touch POS**: Designed for rapid order entry with English and Urdu names (e.g. *Special Karak Chai / سپیشل کڑک چائے*, *Roghani Naan / روغنی نان*, *Crispy Zinger Burger / کرسپی چکن زنگر برگر*).
- **Separate Customer Receipts & Kitchen Slips (KOT)**:
  - **80mm Customer Thermal Receipt**: Displays cafe branding, order number, table/takeaway status, itemized prices, subtotal, discount, grand total, and thank-you note.
  - **Kitchen Order Slips (KOT)**: Automatically splits and routes food tickets to designated stations (**Tandoor Kitchen**, **Fast Food Kitchen**, **Tea & Beverage Bar**, **BBQ Pit**, and **Main Kitchen**). Prices are completely hidden on kitchen slips, and duplicate printing is prevented with explicit reprint tracking.
- **Recipe-Based Inventory Deduction**: Deducts raw ingredients automatically upon order completion (e.g. 1 cup Karak Chai deducts 6g tea leaves, 150ml milk, and 15g sugar). Guaranteed protection against double deduction.
- **Customer & Udhaar (Credit) Management**: Track credit customers, view outstanding balances, record partial/full cash/bank payments, maintain running ledgers, and print payment receipts.
- **Daily Cash Book & Immutable Day Closing**: Live tracking of opening cash, sales, Udhaar recovery, and cash expenses. Cash count denomination wizard (PKR 5000, 1000, 500, 100, 50, 20, 10) with variance calculation. A closed day is permanently locked against silent modification.
- **Operating Expense Management**: Record categorized daily utilities (Electricity, Gas, Rent, Market Grocery, Kitchen Charcoal, Salaries). Automatic separation prevents double-counting market stock purchases in profit calculations.
- **Financial Analytics & Profit Reports**: Real-time Gross Profit, Cost of Goods Sold (COGS), Operating Expenses, and Net Profit statements. Exportable to CSV and printable.
- **Offline & Local First**: Operates seamlessly on local hardware using SQLite (ACID compliant, WAL mode) without requiring continuous internet connectivity.

---

## 2. Directory Structure

```text
roomi-cafe-pos/
├── backend/
│   ├── server.js            # Node.js REST API & static web server
│   ├── db.js                # High-speed SQLite database client
│   ├── services.js          # Core business logic (KOT routing, recipe deduction, cashbook)
│   └── sqlite_worker.py     # Persistent SQLite worker daemon
├── database/
│   ├── init_db.py           # Database schema migration & initial seed script
│   ├── roomi_cafe.db        # Production SQLite database file
│   └── backups/             # Automatic & manual database backup directory
├── public/
│   └── index.html           # Production-ready bilingual PWA frontend
├── scripts/
│   └── test_system.py       # Automated 12-workflow regression test suite
├── package.json             # Node.js project manifest
├── start_pos.bat            # Windows 1-click startup script
├── start_pos.sh             # Linux / macOS startup script
└── README.md                # System documentation & operations manual
```

---

## 3. Installation & Getting Started

### Prerequisites
- **Node.js** (v16 or higher)
- **Python** (v3.8 or higher, pre-installed with SQLite)
- Any modern web browser (Google Chrome, Microsoft Edge, Firefox, or Safari)

### Quick Start (Linux / macOS)
```bash
# 1. Initialize Database and seed sample menu data
python3 database/init_db.py

# 2. Start the Backend Server
node backend/server.js
# Or use the launcher script:
chmod +x start_pos.sh && ./start_pos.sh
```

### Quick Start (Windows)
Double-click `start_pos.bat`. The script automatically initializes the database, starts the server on port 5000, and opens your default browser at `http://localhost:5000`.

---

## 4. Default Staff Logins & Credentials

| Role | Username | Password | Quick PIN | Access Level |
| :--- | :--- | :--- | :--- | :--- |
| **Admin** | `admin` | `admin123` | `1122` | Full system access (reports, menu, stock, cash closing, settings) |
| **Cashier** | `cashier1` | `cashier123` | `2233` | POS counter, open orders, customer receipts, receive payments |
| **Waiter** | `waiter1` | `waiter123` | `4455` | Order entry, table management, kitchen tickets (KOT) |

---

## 5. Thermal Printer Hardware & Setup Guide

### Supported Printers
- **80mm (3.15 inch) Thermal POS Printers** (Epson TM-T88, Xprinter XP-N160II, Rongta, Sunmi, etc.)
- **58mm (2.25 inch) Compact Thermal Printers** (supported via setting toggle)
- Standard USB, Ethernet (LAN / Wi-Fi IP), and Bluetooth POS printers.

### Printing Modes
1. **Browser Direct Print (`window.print`)**:
   - Built into every browser.
   - Set paper size to `80mm` or `Roll Paper` in the browser print dialog. Set margins to `None`.
2. **Local Silent Print Bridge (Raw ESC/POS)**:
   - For unattended automatic printing without popup dialogs, the system integrates with a local print bridge daemon (running on `http://127.0.0.1:9090`).
   - Browser security blocks raw direct USB hardware access without an OS bridge or driver. The system provides ESC/POS formatted payloads for direct spooling to USB/COM ports or network printer IPs (`192.168.1.151:9100`).

### Kitchen Order Ticket (KOT) Station Routing
Under **Settings -> Printers & Setup**, each category is mapped to its target station:
- **Tandoor Category** → `Tandoor Kitchen Printer` (Naan, Roti, Paratha)
- **Fast Food Category** → `Fast Food Kitchen Printer` (Burgers, Shawarma, Fries)
- **Tea & Beverages Category** → `Beverage Counter Printer` (Chai, Doodh Patti, Shakes)
- **BBQ Category** → `BBQ Pit Thermal Printer` (Tikka, Seekh Kabab, Malai Boti)
- **Traditional & Breakfast** → `Main Kitchen Ticket Printer` (Karahi, Halwa Puri)

---

## 6. Daily Operations Walkthrough

### 1. Opening the Day
1. Cashier checks in with PIN `2233`.
2. Navigate to **Daily Cash Closing**. Verify opening cash in till (default PKR 5,000).

### 2. Taking an Order at POS Counter
1. Select order type: **Dine-In** (pick Table T1 to T10), **Takeaway**, or **Delivery**.
2. Tap menu items to add to cart. Adjust quantities with `+` / `-`.
3. Add special cooking instructions (e.g. *"کم میٹھا"*, *"کرسپی زیادہ"*).
4. Apply discount if applicable (fixed PKR or percentage).
5. Click **Pay & Print**:
   - For **Cash**: Enter received amount or tap quick PKR buttons (Rs. 500, 1000, 5000); system shows exact change.
   - For **JazzCash / Easypaisa**: Select digital tender and enter transaction ID.
   - For **Udhaar (Credit)**: Select customer from dropdown; system checks credit limit and updates outstanding ledger balance.
6. The system prints customer 80mm receipt and immediately dispatches segregated KOT slips to the kitchen.

### 3. Multiple Open & Held Orders
- To switch tables or pause an order while customers decide, click **Hold Order**.
- Held orders are safely stored with table numbers and retrieved anytime with single tap.

### 4. Receiving Customer Udhaar Payments
1. Go to **Customers (Udhaar)** tab.
2. Search customer by name or phone number.
3. Click **Receive Payment**. Enter amount received (cash or bank).
4. Customer outstanding balance is instantly reduced, ledger entry recorded, and cashbook updated.

### 5. Closing the Day (Day Closing Wizard)
1. At the end of night shift, Admin navigates to **Daily Cash Closing**.
2. The system computes expected cash:  
   $$\text{Expected Cash} = \text{Opening Cash} + \text{Cash Sales} + \text{Udhaar Cash In} - \text{Cash Expenses}$$
3. Count the till cash notes using the **Denomination Counter** (PKR 5000, 1000, 500, 100, 50, 20, 10).
4. Review the variance (surplus or shortage). Enter shift handover remarks.
5. Click **Permanently Lock & Close Day**. The day is sealed permanently.

---

## 7. Backup and Restore Procedures

- **Automatic Backups**: Backups are written using SQLite's atomic `VACUUM INTO` command, capturing a consistent snapshot even during active transactions.
- **Manual Backup**: In **Settings -> Database Backup**, click **Create & Download Database Backup**.
- **Restore**: Backups are standard SQLite `.db` files. Simply copy the backup file over `database/roomi_cafe.db` while the server is stopped to restore all records.

---

## 8. Verification & Test Suite

The system includes an automated 12-stage test suite:
```bash
python3 scripts/test_system.py
```
This tests:
1. Multi-product order creation
2. 80mm Customer receipt generation
3. Separate Tandoor & Fast Food KOTs without prices
4. Cash payment processing
5. Udhaar credit sale recording
6. Partial Udhaar payment receipt
7. Recipe-based inventory deduction & double-deduction prevention
8. Daily expense categorization
9. Cash book balance calculation & day locking
10. Monthly profit & loss report generation
11. Data persistence across server restarts
12. Database backup creation and restore integrity
