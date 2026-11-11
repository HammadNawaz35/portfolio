#!/usr/bin/env python3
"""
Database initialization and seeding script for ROOMI CAFE POS & Management System.
Creates SQLite database with full relational schema, indexes, constraints,
and comprehensive initial seed data for realistic daily operations in Pakistan.
"""

import sqlite3
import os
import json
import hashlib
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'roomi_cafe.db')

def hash_password(password: str) -> str:
    """Generate SHA256 password hash with salt for secure storage."""
    salt = "roomi_cafe_2026_secure_salt"
    return hashlib.sha256((password + salt).encode('utf-8')).hexdigest()

def get_connection(db_file=DB_PATH):
    conn = sqlite3.connect(db_file)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.row_factory = sqlite3.Row
    return conn

def init_schema(conn):
    cur = conn.cursor()
    
    # 1. Users & Staff
    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'cashier', 'waiter')),
        pin_code TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 2. Categories with Kitchen Station mapping
    cur.execute("""
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name_en TEXT NOT NULL,
        name_ur TEXT NOT NULL,
        icon TEXT DEFAULT 'coffee',
        kitchen_station TEXT NOT NULL DEFAULT 'Main Kitchen',
        printer_target TEXT DEFAULT 'default',
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1
    );
    """)

    # 3. Products / Menu items
    cur.execute("""
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name_en TEXT NOT NULL,
        name_ur TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        kitchen_station TEXT NOT NULL,
        selling_price REAL NOT NULL,
        purchase_cost REAL DEFAULT 0.0,
        image_url TEXT,
        is_available INTEGER DEFAULT 1,
        has_recipe INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 4. Inventory Suppliers
    cur.execute("""
    CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 5. Inventory Items (Raw materials / Stock)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS inventory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name_en TEXT NOT NULL,
        name_ur TEXT NOT NULL,
        unit TEXT NOT NULL, -- 'kg', 'g', 'l', 'ml', 'pcs', 'pack'
        current_stock REAL NOT NULL DEFAULT 0.0,
        min_stock_alert REAL NOT NULL DEFAULT 5.0,
        purchase_cost_per_unit REAL NOT NULL DEFAULT 0.0,
        supplier_id INTEGER REFERENCES suppliers(id),
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 6. Product Recipes (Bill of Materials)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS recipes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
        quantity_required REAL NOT NULL, -- amount of unit deducted per 1 unit of product
        UNIQUE(product_id, inventory_item_id)
    );
    """)

    # 7. Stock Transactions (Purchases, Deductions, Adjustments)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS stock_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
        transaction_type TEXT NOT NULL CHECK(transaction_type IN ('purchase', 'sale_deduction', 'adjustment', 'opening', 'waste')),
        quantity REAL NOT NULL,
        unit_cost REAL DEFAULT 0.0,
        total_amount REAL DEFAULT 0.0,
        reference_id TEXT, -- e.g. order_id, purchase_bill_no
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 8. Customers & Udhaar (Credit) Accounts
    cur.execute("""
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        address TEXT,
        opening_balance REAL DEFAULT 0.0,
        current_balance REAL DEFAULT 0.0, -- Positive means customer owes us money (Udhaar)
        total_purchased REAL DEFAULT 0.0,
        credit_limit REAL DEFAULT 20000.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 9. Customer Ledger (Detailed Transaction History)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS customer_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        transaction_type TEXT NOT NULL CHECK(transaction_type IN ('credit_sale', 'payment_received', 'opening_balance', 'adjustment')),
        amount REAL NOT NULL,
        balance_after REAL NOT NULL,
        reference_order_id INTEGER REFERENCES orders(id),
        payment_method TEXT, -- 'cash', 'easypaisa', 'jazzcash', 'bank'
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 10. Orders
    cur.execute("""
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT UNIQUE NOT NULL, -- e.g. RC-20261104-001
        daily_seq INTEGER NOT NULL,
        order_type TEXT NOT NULL CHECK(order_type IN ('dine_in', 'takeaway', 'delivery')),
        table_number TEXT,
        customer_id INTEGER REFERENCES customers(id),
        customer_name TEXT,
        customer_phone TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_kitchen', 'served', 'completed', 'cancelled', 'held')),
        subtotal REAL NOT NULL DEFAULT 0.0,
        discount_type TEXT CHECK(discount_type IN ('fixed', 'percent', 'none')),
        discount_value REAL DEFAULT 0.0,
        discount_amount REAL DEFAULT 0.0,
        tax_amount REAL DEFAULT 0.0,
        grand_total REAL NOT NULL DEFAULT 0.0,
        payment_status TEXT NOT NULL CHECK(payment_status IN ('unpaid', 'paid', 'partially_paid', 'udhaar')),
        payment_method TEXT CHECK(payment_method IN ('cash', 'easypaisa', 'jazzcash', 'bank', 'udhaar', 'split', 'unpaid')),
        special_instructions TEXT,
        waiter_name TEXT,
        cashier_name TEXT,
        is_stock_deducted INTEGER DEFAULT 0,
        is_closed_in_cashbook INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    );
    """)

    # 11. Order Items
    cur.execute("""
    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        product_name_en TEXT NOT NULL,
        product_name_ur TEXT NOT NULL,
        kitchen_station TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        unit_price REAL NOT NULL,
        total_price REAL NOT NULL,
        special_instructions TEXT,
        kot_printed INTEGER DEFAULT 0,
        kot_ticket_id INTEGER
    );
    """)

    # 12. Order Payments (supports split payments)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'easypaisa', 'jazzcash', 'bank', 'udhaar')),
        amount REAL NOT NULL,
        reference_number TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 13. KOT (Kitchen Order Tickets) History
    cur.execute("""
    CREATE TABLE IF NOT EXISTS kot_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_number TEXT UNIQUE NOT NULL,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        order_number TEXT NOT NULL,
        station TEXT NOT NULL,
        order_type TEXT NOT NULL,
        table_number TEXT,
        items_json TEXT NOT NULL,
        special_instructions TEXT,
        print_count INTEGER DEFAULT 1,
        last_printed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent'
    );
    """)

    # 14. Expenses
    cur.execute("""
    CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('Electricity', 'Gas', 'Rent', 'Salaries', 'Grocery/Market', 'Maintenance', 'Fuel', 'Tea Supplies', 'Cleaning', 'Other')),
        amount REAL NOT NULL,
        payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
        expense_date DATE NOT NULL,
        description TEXT,
        is_inventory_purchase INTEGER DEFAULT 0, -- Prevents double counting in net profit
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 15. Daily Cash Book & Closing
    cur.execute("""
    CREATE TABLE IF NOT EXISTS cash_closings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        closing_date DATE UNIQUE NOT NULL,
        opened_at DATETIME NOT NULL,
        closed_at DATETIME,
        opening_cash REAL NOT NULL DEFAULT 0.0,
        cash_sales REAL NOT NULL DEFAULT 0.0,
        cash_from_udhaar REAL NOT NULL DEFAULT 0.0,
        cash_expenses REAL NOT NULL DEFAULT 0.0,
        cash_withdrawals REAL NOT NULL DEFAULT 0.0,
        expected_cash REAL NOT NULL DEFAULT 0.0,
        actual_cash REAL NOT NULL DEFAULT 0.0,
        variance REAL NOT NULL DEFAULT 0.0,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
        closed_by_user TEXT,
        notes TEXT,
        is_locked INTEGER DEFAULT 0,
        adjustments_json TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 16. Audit Logs
    cur.execute("""
    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_name TEXT,
        role TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 17. System Settings & Printer Station Mapping
    cur.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """)

    # Indexes for fast daily querying and reports
    cur.execute("CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger(customer_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_trans_item ON stock_transactions(inventory_item_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_cash_closings_date ON cash_closings(closing_date);")

    conn.commit()
    print("[OK] Schema initialized successfully.")

def seed_data(conn):
    cur = conn.cursor()

    # Check if already seeded
    cur.execute("SELECT COUNT(*) FROM users;")
    if cur.fetchone()[0] > 0:
        print("[INFO] Database already contains data. Skipping seed.")
        return

    print("[INFO] Seeding initial data for ROOMI CAFE...")

    # 1. Staff Users
    admin_pw = hash_password("admin123")
    cashier_pw = hash_password("cashier123")
    waiter_pw = hash_password("waiter123")

    cur.execute("""
    INSERT INTO users (username, password_hash, full_name, role, pin_code) VALUES
    ('admin', ?, 'Cafe Manager (Admin)', 'admin', '1122'),
    ('cashier1', ?, 'Tariq Cashier', 'cashier', '2233'),
    ('waiter1', ?, 'Asad Waiter', 'waiter', '4455');
    """, (admin_pw, cashier_pw, waiter_pw))

    # 2. Categories with Kitchen Station assignments
    categories = [
        ('Tea and Coffee', 'چائے اور کافی', 'coffee', 'Tea & Beverage', 'printer_beverage', 1),
        ('Tandoor', 'تندور', 'flame', 'Tandoor Kitchen', 'printer_tandoor', 2),
        ('Fast Food', 'فاسٹ فوڈ', 'utensils', 'Fast Food Kitchen', 'printer_fastfood', 3),
        ('BBQ', 'باربی کیو', 'fire', 'BBQ Station', 'printer_bbq', 4),
        ('Breakfast', 'روایتی ناشتہ', 'sun', 'Main Kitchen', 'printer_main', 5),
        ('Cold Drinks & Shakes', 'کولڈ ڈرنکس اور شیکس', 'glass-water', 'Tea & Beverage', 'printer_beverage', 6),
        ('Snacks', 'سنیکس اور رول', 'cookie', 'Fast Food Kitchen', 'printer_fastfood', 7),
        ('Traditional Dishes', 'روایتی کھانے اور سالن', 'soup', 'Main Kitchen', 'printer_main', 8),
    ]

    for cat in categories:
        cur.execute("""
        INSERT INTO categories (name_en, name_ur, icon, kitchen_station, printer_target, sort_order)
        VALUES (?, ?, ?, ?, ?, ?);
        """, cat)

    # 3. Suppliers
    suppliers = [
        ('Al-Rehman Dairy Farm', '0300-1234567', 'Chak 42, Faisalabad Road'),
        ('National Spices & Grocery Wholesale', '0321-7654321', 'Anarkali Wholesale Bazaar, Lahore'),
        ('Khyber Poultry & Meat Supplier', '0333-9876543', 'Tollinton Market, Lahore'),
        ('Metro Packaging & Disposables', '0345-5554321', 'Circular Road, Lahore'),
    ]
    for sup in suppliers:
        cur.execute("INSERT INTO suppliers (name, phone, address) VALUES (?, ?, ?);", sup)

    # 4. Inventory Raw Materials
    raw_materials = [
        ('RAW-TEA', 'Danedar Tea Leaves', 'دانے دار چائے کی پتی', 'kg', 18.5, 3.0, 1600.0, 2),
        ('RAW-MILK', 'Fresh Buffalo Milk', 'تازہ خالص بھینس کا دودھ', 'l', 45.0, 10.0, 210.0, 1),
        ('RAW-SUGAR', 'Refined White Sugar', 'سفید چینی', 'kg', 35.0, 10.0, 150.0, 2),
        ('RAW-ELAICHI', 'Green Cardamom (Elaichi)', 'سبز الائچی', 'g', 450.0, 100.0, 8.0, 2),
        ('RAW-MAIDA', 'Fine Wheat Flour (Maida)', 'فائن میدہ', 'kg', 75.0, 20.0, 140.0, 2),
        ('RAW-ATTA', 'Whole Wheat Atta', 'چکی کا آٹا', 'kg', 60.0, 15.0, 130.0, 2),
        ('RAW-OIL', 'Cooking Oil / Ghee', 'کوکنگ آئل / گھی', 'l', 40.0, 10.0, 520.0, 2),
        ('RAW-CHKN-PATTY', 'Zinger Chicken Fillet/Patty', 'زنگر چکن فلے', 'pcs', 65.0, 15.0, 180.0, 3),
        ('RAW-BUN', 'Burger Buns Sesame', 'برگر تل والے بن', 'pcs', 70.0, 20.0, 45.0, 2),
        ('RAW-POTATO', 'Fresh Potatoes for Fries', 'آلو چپس والے', 'kg', 50.0, 15.0, 85.0, 2),
        ('RAW-MAYO-SAUCE', 'Garlic Mayo Sauce', 'مایونیز اور گارلک ساس', 'kg', 12.0, 3.0, 380.0, 2),
        ('RAW-CHKN-TIKKA', 'Marinated Chicken Tikka Piece', 'میرینیٹڈ چکن تکہ بوٹی', 'pcs', 40.0, 10.0, 220.0, 3),
        ('RAW-BEEF-KABAB', 'Prepared Seekh Kabab Mince', 'تیار شدہ سیخ کباب قیمہ', 'kg', 15.0, 5.0, 1100.0, 3),
        ('RAW-PURI-DOUGH', 'Puri Prepared Dough', 'پوڑی کا پیڑا', 'pcs', 80.0, 20.0, 25.0, 2),
        ('RAW-CHANA', 'Chana Gravy Base', 'چنا گریوی بنیاد', 'kg', 25.0, 5.0, 180.0, 2),
        ('RAW-MANGO-PULP', 'Mango Shake Pulp', 'مینگو پلپ', 'kg', 15.0, 4.0, 320.0, 2),
    ]

    for raw in raw_materials:
        cur.execute("""
        INSERT INTO inventory_items (code, name_en, name_ur, unit, current_stock, min_stock_alert, purchase_cost_per_unit, supplier_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        """, raw)

    # 5. Products / Menu items
    # Category IDs:
    # 1: Tea & Coffee (Tea & Beverage)
    # 2: Tandoor (Tandoor Kitchen)
    # 3: Fast Food (Fast Food Kitchen)
    # 4: BBQ (BBQ Station)
    # 5: Breakfast (Main Kitchen)
    # 6: Cold Drinks (Tea & Beverage)
    # 7: Snacks (Fast Food Kitchen)
    # 8: Traditional Dishes (Main Kitchen)
    
    products = [
        # (code, name_en, name_ur, cat_id, station, price, cost, has_recipe)
        # Tea & Coffee
        ('RC-TEA-01', 'Special Karak Chai', 'سپیشل کڑک چائے', 1, 'Tea & Beverage', 90.0, 38.0, 1),
        ('RC-TEA-02', 'Doodh Patti Chai', 'دودھ پتی چائے', 1, 'Tea & Beverage', 130.0, 62.0, 1),
        ('RC-TEA-03', 'Special Elaichi Chai', 'سپیشل الائچی چائے', 1, 'Tea & Beverage', 110.0, 48.0, 1),
        ('RC-TEA-04', 'Kashmiri Chai (Pink Tea)', 'کشمیری گلابی چائے', 1, 'Tea & Beverage', 180.0, 75.0, 0),
        ('RC-TEA-05', 'Green Tea / Peshawari Qahwa', 'سبز قہوہ پشاوری', 1, 'Tea & Beverage', 70.0, 20.0, 0),
        
        # Tandoor
        ('RC-TND-01', 'Roghani Naan', 'روغنی نان تل والا', 2, 'Tandoor Kitchen', 60.0, 22.0, 1),
        ('RC-TND-02', 'Sada Tandoori Roti', 'سادہ تندوری روٹی', 2, 'Tandoor Kitchen', 25.0, 9.0, 1),
        ('RC-TND-03', 'Khamiri Roti', 'خمیری روٹی', 2, 'Tandoor Kitchen', 35.0, 12.0, 1),
        ('RC-TND-04', 'Garlic Naan', 'گارلک نان', 2, 'Tandoor Kitchen', 90.0, 35.0, 0),
        ('RC-TND-05', 'Tandoori Paratha', 'تندوری پراٹھا کرسپی', 2, 'Tandoor Kitchen', 80.0, 28.0, 1),

        # Fast Food
        ('RC-FF-01', 'Crispy Chicken Zinger Burger', 'کرسپی چکن زنگر برگر', 3, 'Fast Food Kitchen', 380.0, 210.0, 1),
        ('RC-FF-02', 'Chicken Shawarma Wrap', 'چکن شاورما ریپ', 3, 'Fast Food Kitchen', 220.0, 115.0, 0),
        ('RC-FF-03', 'Crispy French Fries (Large)', 'کرسپی فرینچ فرائز (بڑی)', 3, 'Fast Food Kitchen', 200.0, 75.0, 1),
        ('RC-FF-04', 'Chicken Club Sandwich', 'چکن کلب سینڈوچ مع چپس', 3, 'Fast Food Kitchen', 360.0, 185.0, 0),
        ('RC-FF-05', 'Loaded Cheese Fries', 'لوڈڈ چیز فرائز', 3, 'Fast Food Kitchen', 350.0, 160.0, 1),

        # BBQ
        ('RC-BBQ-01', 'Chicken Tikka Chest Piece', 'چکن تکہ سینہ پیس', 4, 'BBQ Station', 350.0, 190.0, 1),
        ('RC-BBQ-02', 'Chicken Tikka Leg Piece', 'چکن تکہ لیگ پیس', 4, 'BBQ Station', 330.0, 175.0, 1),
        ('RC-BBQ-03', 'Beef Seekh Kabab (4 Pcs)', 'بیف سیخ کباب (۴ عدد)', 4, 'BBQ Station', 480.0, 260.0, 1),
        ('RC-BBQ-04', 'Chicken Malai Boti (Plate)', 'چکن ملائی بوٹی پلیٹ', 4, 'BBQ Station', 550.0, 310.0, 0),

        # Breakfast
        ('RC-BF-01', 'Halwa Puri Thali (2 Puri + Chana + Halwa)', 'حلوہ پوری تھالی (۲ پوری+چنا+حلوہ)', 5, 'Main Kitchen', 220.0, 95.0, 1),
        ('RC-BF-02', 'Desi Ghee Paratha', 'دیسی گھی پراٹھا', 5, 'Main Kitchen', 120.0, 48.0, 0),
        ('RC-BF-03', 'Cheese Omelette', 'پنیر اور انڈے کا آملیٹ', 5, 'Main Kitchen', 140.0, 65.0, 0),

        # Cold Drinks & Shakes
        ('RC-CD-01', 'Fresh Mint Lemonade', 'تازہ پودینہ لیمونیڈ', 6, 'Tea & Beverage', 160.0, 45.0, 0),
        ('RC-CD-02', 'Special Mango Shake', 'سپیشل مینگو شیک', 6, 'Tea & Beverage', 240.0, 95.0, 1),
        ('RC-CD-03', 'Sweet / Salted Lassi', 'میٹھی یا نمکین لسی', 6, 'Tea & Beverage', 180.0, 70.0, 1),
        ('RC-CD-04', 'Soft Drink Can (330ml)', 'کولڈ ڈرنک کین', 6, 'Tea & Beverage', 100.0, 72.0, 0),
        ('RC-CD-05', 'Mineral Water (500ml)', 'منرل واٹر (چھوٹی بوتل)', 6, 'Tea & Beverage', 60.0, 35.0, 0),

        # Snacks
        ('RC-SNK-01', 'Crispy Chicken Roll', 'کرسپی چکن رول پراٹھا', 7, 'Fast Food Kitchen', 220.0, 110.0, 0),
        ('RC-SNK-02', 'Samosa Chaat Plate', 'سموسہ چاٹ پلیٹ چٹنی دار', 7, 'Fast Food Kitchen', 150.0, 55.0, 0),

        # Traditional Dishes
        ('RC-TD-01', 'Chicken Karahi (Half)', 'چکن کڑاہی دیسی گھی (ہاف)', 8, 'Main Kitchen', 850.0, 480.0, 0),
        ('RC-TD-02', 'Daal Mash Special', 'دال ماش مکھنی فرائی', 8, 'Main Kitchen', 320.0, 140.0, 0),
    ]

    for p in products:
        cur.execute("""
        INSERT INTO products (code, name_en, name_ur, category_id, kitchen_station, selling_price, purchase_cost, is_available, has_recipe)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?);
        """, p)

    # 6. Recipes (Recipe-based inventory deduction mapping)
    # Find IDs
    cur.execute("SELECT id, code FROM products;")
    p_map = {row['code']: row['id'] for row in cur.fetchall()}
    cur.execute("SELECT id, code FROM inventory_items;")
    inv_map = {row['code']: row['id'] for row in cur.fetchall()}

    recipes_data = [
        # Special Karak Chai (TEA-01): 0.006 kg tea (6g), 0.15 l milk (150ml), 0.015 kg sugar (15g)
        (p_map['RC-TEA-01'], inv_map['RAW-TEA'], 0.006),
        (p_map['RC-TEA-01'], inv_map['RAW-MILK'], 0.150),
        (p_map['RC-TEA-01'], inv_map['RAW-SUGAR'], 0.015),

        # Doodh Patti (TEA-02): 0.008 kg tea (8g), 0.25 l milk (250ml), 0.018 kg sugar (18g)
        (p_map['RC-TEA-02'], inv_map['RAW-TEA'], 0.008),
        (p_map['RC-TEA-02'], inv_map['RAW-MILK'], 0.250),
        (p_map['RC-TEA-02'], inv_map['RAW-SUGAR'], 0.018),

        # Special Elaichi Chai (TEA-03): 0.006 kg tea, 0.16 l milk, 0.015 kg sugar, 1g elaichi
        (p_map['RC-TEA-03'], inv_map['RAW-TEA'], 0.006),
        (p_map['RC-TEA-03'], inv_map['RAW-MILK'], 0.160),
        (p_map['RC-TEA-03'], inv_map['RAW-SUGAR'], 0.015),
        (p_map['RC-TEA-03'], inv_map['RAW-ELAICHI'], 1.0),

        # Roghani Naan: 0.15 kg maida, 0.02 l oil/ghee
        (p_map['RC-TND-01'], inv_map['RAW-MAIDA'], 0.150),
        (p_map['RC-TND-01'], inv_map['RAW-OIL'], 0.020),

        # Sada Tandoori Roti: 0.10 kg atta
        (p_map['RC-TND-02'], inv_map['RAW-ATTA'], 0.100),

        # Tandoori Paratha: 0.14 kg atta, 0.035 l ghee
        (p_map['RC-TND-05'], inv_map['RAW-ATTA'], 0.140),
        (p_map['RC-TND-05'], inv_map['RAW-OIL'], 0.035),

        # Crispy Chicken Zinger Burger: 1 patty, 1 bun, 0.03 kg mayo
        (p_map['RC-FF-01'], inv_map['RAW-CHKN-PATTY'], 1.0),
        (p_map['RC-FF-01'], inv_map['RAW-BUN'], 1.0),
        (p_map['RC-FF-01'], inv_map['RAW-MAYO-SAUCE'], 0.030),

        # Large Fries: 0.35 kg potatoes, 0.04 l oil
        (p_map['RC-FF-03'], inv_map['RAW-POTATO'], 0.350),
        (p_map['RC-FF-03'], inv_map['RAW-OIL'], 0.040),

        # Chicken Tikka Chest: 1 tikka piece
        (p_map['RC-BBQ-01'], inv_map['RAW-CHKN-TIKKA'], 1.0),

        # Beef Seekh Kabab: 0.25 kg kabab mince
        (p_map['RC-BBQ-03'], inv_map['RAW-BEEF-KABAB'], 0.250),

        # Halwa Puri Thali: 2 puris, 0.15 kg chana gravy
        (p_map['RC-BF-01'], inv_map['RAW-PURI-DOUGH'], 2.0),
        (p_map['RC-BF-01'], inv_map['RAW-CHANA'], 0.150),

        # Special Mango Shake: 0.25 l milk, 0.12 kg pulp, 0.02 kg sugar
        (p_map['RC-CD-02'], inv_map['RAW-MILK'], 0.250),
        (p_map['RC-CD-02'], inv_map['RAW-MANGO-PULP'], 0.120),
        (p_map['RC-CD-02'], inv_map['RAW-SUGAR'], 0.020),

        # Lassi: 0.35 l milk, 0.025 kg sugar
        (p_map['RC-CD-03'], inv_map['RAW-MILK'], 0.350),
        (p_map['RC-CD-03'], inv_map['RAW-SUGAR'], 0.025),
    ]

    for rec in recipes_data:
        cur.execute("""
        INSERT INTO recipes (product_id, inventory_item_id, quantity_required)
        VALUES (?, ?, ?);
        """, rec)

    # 7. Customers with initial Udhaar accounts
    customers = [
        ('Malik Usman (Shop 14)', '0301-4455667', 'Shop 14, Main Market, Lahore', 1500.0, 3200.0, 18500.0),
        ('Chaudhry Riaz Advocate', '0322-8877665', 'Chamber 4B, District Courts', 0.0, 1250.0, 9400.0),
        ('Doctor Bilal Dental Clinic', '0334-1122334', 'Dental Plaza, 2nd Floor', 0.0, 0.0, 6800.0),
        ('Hafiz Zubair Textile', '0313-5566778', 'Madina Market, Shop 8', 500.0, 4600.0, 24000.0),
        ('Walk-in Customer', '0300-0000000', 'Counter Walk-in', 0.0, 0.0, 52000.0),
    ]

    for cust in customers:
        cur.execute("""
        INSERT INTO customers (name, phone, address, opening_balance, current_balance, total_purchased)
        VALUES (?, ?, ?, ?, ?, ?);
        """, cust)
        cust_id = cur.lastrowid
        # Add opening ledger entry if opening balance > 0
        if cust[3] > 0:
            cur.execute("""
            INSERT INTO customer_ledger (customer_id, transaction_type, amount, balance_after, notes)
            VALUES (?, 'opening_balance', ?, ?, 'Initial Udhaar balance brought forward');
            """, (cust_id, cust[3], cust[3]))

    # 8. Sample Expenses (for today and current month)
    today_str = datetime.now().strftime('%Y-%m-%d')
    cur.execute("""
    INSERT INTO expenses (title, category, amount, payment_method, expense_date, description, is_inventory_purchase) VALUES
    ('LESCO Commercial Electricity Bill', 'Electricity', 14500.0, 'bank', ?, 'Monthly electricity payment for cafe', 0),
    ('SNGPL Commercial Gas Bill', 'Gas', 6200.0, 'bank', ?, 'Monthly kitchen commercial meter bill', 0),
    ('Daily Milk & Dairy Delivery', 'Grocery/Market', 4200.0, 'cash', ?, 'Morning dairy supplies payment', 1),
    ('Dishwashing and Cleaning Supplies', 'Cleaning', 1250.0, 'cash', ?, 'Vim, Surf, mop and trash bags', 0),
    ('Tandoor Firewood & Charcoal Refill', 'Fuel', 2800.0, 'cash', ?, 'Hardwood charcoal for tandoor and BBQ pit', 0);
    """, (today_str, today_str, today_str, today_str, today_str))

    # 9. Daily Cash Book Opening for Today
    cur.execute("""
    INSERT INTO cash_closings (
        closing_date, opened_at, opening_cash, cash_sales, cash_from_udhaar,
        cash_expenses, cash_withdrawals, expected_cash, actual_cash, variance,
        status, notes
    ) VALUES (
        ?, CURRENT_TIMESTAMP, 5000.0, 0.0, 0.0, 0.0, 0.0, 5000.0, 0.0, 0.0, 'open', 'Morning opening cash in counter till'
    );
    """, (today_str,))

    # 10. System Settings & Thermal Printer Configuration
    settings_dict = {
        "restaurant_name": "ROOMI CAFE",
        "tagline": "Authentic Taste, Chai & Fast Food",
        "address": "Main Commercial Market, Gulberg III, Lahore, Pakistan",
        "phone": "+92 300 7666422 / 042-35789123",
        "ntn": "7864321-9",
        "currency": "PKR",
        "currency_symbol": "Rs.",
        "receipt_header": "WELCOME TO ROOMI CAFE\nServing Fresh Karak Chai, Naan, BBQ & Burgers",
        "receipt_footer": "Thank you for dining with us!\nSoftware by Roomi POS • 0300-7666422\nPlease visit again!",
        "thermal_printer_paper_width": "80mm", # Options: 80mm, 58mm
        "auto_print_customer_receipt": True,
        "auto_print_kitchen_slips": True,
        "prevent_duplicate_kot": True,
        "tax_rate_percent": 0.0,
        "kitchen_stations": [
            {"id": "Tandoor Kitchen", "name": "Tandoor Kitchen (تندور)", "printer": "printer_tandoor", "enabled": True},
            {"id": "Fast Food Kitchen", "name": "Fast Food Kitchen (فاسٹ فوڈ)", "printer": "printer_fastfood", "enabled": True},
            {"id": "Tea & Beverage", "name": "Tea & Beverage (چائے اور بار)", "printer": "printer_beverage", "enabled": True},
            {"id": "BBQ Station", "name": "BBQ Pit & Grill (باربی کیو)", "printer": "printer_bbq", "enabled": True},
            {"id": "Main Kitchen", "name": "Main Kitchen (مین کچن)", "printer": "printer_main", "enabled": True}
        ],
        "printer_targets": [
            {"id": "printer_customer", "name": "Cashier Counter 80mm Printer", "type": "thermal_80mm", "ip_or_usb": "USB001 / COM1"},
            {"id": "printer_tandoor", "name": "Tandoor Station 80mm Printer", "type": "thermal_80mm", "ip_or_usb": "192.168.1.151:9100"},
            {"id": "printer_fastfood", "name": "Fast Food Kitchen Printer", "type": "thermal_80mm", "ip_or_usb": "192.168.1.152:9100"},
            {"id": "printer_beverage", "name": "Chai & Drinks Counter Printer", "type": "thermal_58mm", "ip_or_usb": "192.168.1.153:9100"},
            {"id": "printer_bbq", "name": "BBQ Station Thermal Printer", "type": "thermal_80mm", "ip_or_usb": "192.168.1.154:9100"},
            {"id": "printer_main", "name": "Main Kitchen Ticket Printer", "type": "thermal_80mm", "ip_or_usb": "192.168.1.155:9100"}
        ],
        "silent_printing_mode": "browser_dialog_or_bridge",
        "print_bridge_url": "http://127.0.0.1:9090"
    }

    for k, v in settings_dict.items():
        cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);", (k, json.dumps(v)))

    conn.commit()
    print("[OK] Initial seed data created successfully!")

if __name__ == "__main__":
    conn = get_connection()
    init_schema(conn)
    seed_data(conn)
    conn.close()
