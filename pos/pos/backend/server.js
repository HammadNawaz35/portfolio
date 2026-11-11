/**
 * ROOMI CAFE - Complete Restaurant POS, Inventory, Supplier & Double-Entry Accounting Server (v2.0)
 * Preserves all existing endpoints and adds comprehensive v2.0 endpoints for:
 *  - Complete Product Management (variants, barcode, units, archive/restore, history)
 *  - Complete Stock & Inventory Register (opening, purchased, consumed, returned, damaged, reconciliation)
 *  - Complete Supplier Management (GRN/PO/Returns, Supplier Payments, Supplier Ledger)
 *  - Double-Entry Accounting (12 Chart of Accounts, Journal Entries, Trial Balance, Balance Sheet, Daily Financial Summary)
 *  - Advanced Order Management (Table transfer, merge orders, split bill, refund/cancellation reversal, kitchen prep status)
 *  - Shift Management (open/close/authorized reopen) & Automatic Backup Scheduler
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const services = require('./services');
const accounting = require('./accounting');
const backupScheduler = require('./backup_scheduler');
const escposBridge = require('./escpos_bridge');

const PORT = process.env.PORT || 5000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, details = null) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify({ success: false, error: message, details }));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 10 * 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Start background automatic daily backup scheduler
backupScheduler.startBackupScheduler();

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();
  const query = parsedUrl.query;

  if (method === 'OPTIONS') {
    res.writeHead(204, JSON_HEADERS);
    return res.end();
  }

  try {
    // ----------------------------------------------------
    // 1. AUTHENTICATION & PASSWORD CHANGE
    // ----------------------------------------------------
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { username, password, pin } = await parseBody(req);
      let user = null;
      if (pin) {
        user = await db.queryOne("SELECT id, username, full_name, role, is_active FROM users WHERE pin_code = ? AND is_active = 1", [pin]);
      } else if (username && password) {
        const hashed = services.hashPassword(password);
        user = await db.queryOne("SELECT id, username, full_name, role, is_active FROM users WHERE username = ? AND password_hash = ? AND is_active = 1", [username, hashed]);
      }
      if (!user) return sendError(res, 401, "Invalid username, password, or PIN code.");

      await db.execute("INSERT INTO audit_logs (user_name, role, action, details) VALUES (?, ?, 'LOGIN', 'User logged into POS')", [user.username, user.role]);
      return sendJSON(res, 200, {
        success: true,
        user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role },
        token: `token_${user.id}_${Date.now()}`
      });
    }

    if (pathname === '/api/auth/change-password' && method === 'POST') {
      const { username, old_password, new_password } = await parseBody(req);
      const oldHash = services.hashPassword(old_password || '');
      const user = await db.queryOne("SELECT id, role FROM users WHERE username = ? AND password_hash = ?", [username, oldHash]);
      if (!user) return sendError(res, 401, "Current password is incorrect.");
      const newHash = services.hashPassword(new_password);
      await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, user.id]);
      await db.execute("INSERT INTO audit_logs (user_name, role, action, details) VALUES (?, ?, 'PASSWORD_CHANGE', 'User changed password')", [username, user.role]);
      return sendJSON(res, 200, { success: true, message: "Password updated successfully." });
    }

    // ----------------------------------------------------
    // 2. DASHBOARD & ANALYTICS OVERVIEW
    // ----------------------------------------------------
    if (pathname === '/api/dashboard/stats' && method === 'GET') {
      const filter = query.filter || 'today';
      let dateCondition = "DATE(created_at, '+5 hours') = DATE('now', '+5 hours')";
      let expenseCondition = "expense_date = DATE('now', '+5 hours')";
      if (filter === 'weekly') {
        dateCondition = "DATE(created_at, '+5 hours') >= DATE('now', '+5 hours', '-7 days')";
        expenseCondition = "expense_date >= DATE('now', '+5 hours', '-7 days')";
      } else if (filter === 'monthly') {
        dateCondition = "strftime('%Y-%m', created_at, '+5 hours') = strftime('%Y-%m', 'now', '+5 hours')";
        expenseCondition = "strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now', '+5 hours')";
      }

      const salesRow = await db.queryOne(`
        SELECT COALESCE(SUM(grand_total), 0) as total_sales, COUNT(*) as total_orders
        FROM orders WHERE status NOT IN ('cancelled', 'refunded') AND ${dateCondition}
      `);

      const payRows = await db.query(`
        SELECT op.payment_method, COALESCE(SUM(op.amount), 0) as total
        FROM order_payments op
        JOIN orders o ON op.order_id = o.id
        WHERE o.status NOT IN ('cancelled', 'refunded') AND ${dateCondition}
        GROUP BY op.payment_method
      `);
      const payMap = { cash: 0, easypaisa: 0, jazzcash: 0, bank: 0, udhaar: 0 };
      payRows.forEach(r => { payMap[r.payment_method] = r.total; });

      const expRow = await db.queryOne(`
        SELECT COALESCE(SUM(amount), 0) as total_expenses
        FROM expenses WHERE ${expenseCondition}
      `);

      const pendingRow = await db.queryOne("SELECT COUNT(*) as pending_count FROM orders WHERE status IN ('pending', 'in_kitchen') OR prep_status IN ('pending', 'preparing')");
      const lowStockItems = await db.query("SELECT * FROM inventory_items WHERE current_stock <= min_stock_alert ORDER BY current_stock ASC");
      const topSelling = await db.query(`
        SELECT oi.product_name_en, oi.product_name_ur, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue
        FROM order_items oi JOIN orders o ON oi.order_id = o.id
        WHERE o.status NOT IN ('cancelled', 'refunded')
        GROUP BY oi.product_id ORDER BY total_qty DESC LIMIT 10
      `);

      const tb = await accounting.getTrialBalance();

      const totalSales = salesRow ? salesRow.total_sales : 0;
      const totalExpenses = expRow ? expRow.total_expenses : 0;
      return sendJSON(res, 200, {
        success: true,
        stats: {
          todayTotalSales: totalSales,
          todayCashSales: payMap.cash || 0,
          todayOnlineSales: (payMap.easypaisa || 0) + (payMap.jazzcash || 0) + (payMap.bank || 0),
          todayCreditSales: payMap.udhaar || 0,
          totalExpenses,
          netDailyIncome: totalSales - totalExpenses,
          totalOrders: salesRow ? salesRow.total_orders : 0,
          pendingKitchenOrders: pendingRow ? pendingRow.pending_count : 0,
          lowStockCount: lowStockItems.length,
          lowStockItems,
          topSellingProducts: topSelling,
          paymentBreakdown: payMap,
          trialBalance: tb,
          filter
        }
      });
    }

    // ----------------------------------------------------
    // 3. COMPLETE PRODUCT MANAGEMENT (VARIANTS, BARCODE, ARCHIVE, HISTORY)
    // ----------------------------------------------------
    if (pathname === '/api/categories' && method === 'GET') {
      const categories = await db.query("SELECT * FROM categories ORDER BY sort_order ASC, name_en ASC");
      return sendJSON(res, 200, { success: true, categories });
    }

    if (pathname === '/api/products' && method === 'GET') {
      const includeArchived = query.include_archived === '1';
      let sql = `
        SELECT p.*, c.name_en as category_name_en, c.name_ur as category_name_ur,
               (p.selling_price - p.purchase_cost) as profit_amount,
               CASE WHEN p.selling_price > 0 THEN ROUND(((p.selling_price - p.purchase_cost) / p.selling_price) * 100, 1) ELSE 0 END as profit_margin_percent
        FROM products p
        JOIN categories c ON p.category_id = c.id
      `;
      if (!includeArchived) sql += " WHERE COALESCE(p.is_archived, 0) = 0";
      sql += " ORDER BY c.sort_order ASC, p.name_en ASC";
      const products = await db.query(sql);
      return sendJSON(res, 200, { success: true, products });
    }

    if (pathname === '/api/products' && method === 'POST') {
      const data = await parseBody(req);
      const code = data.code || `RC-PRD-${Date.now().toString().slice(-4)}`;
      const barcode = data.barcode || `8964000${Date.now().toString().slice(-5)}`;
      const variantsJson = typeof data.variants === 'string' ? data.variants : JSON.stringify(data.variants || [{ name: 'Standard', price: data.selling_price, cost: data.purchase_cost || 0 }]);
      const resDb = await db.execute(`
        INSERT INTO products (
          code, barcode, name_en, name_ur, category_id, subcategory, unit, kitchen_station,
          selling_price, purchase_cost, variants_json, tax_rate, max_discount, image_url, is_available, has_recipe
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        code, barcode, data.name_en, data.name_ur || data.name_en, data.category_id || 1,
        data.subcategory || 'General', data.unit || 'piece', data.kitchen_station || 'Main Kitchen',
        data.selling_price, data.purchase_cost || 0, variantsJson, data.tax_rate || 0,
        data.max_discount || 0, data.image_url || '', data.is_available !== undefined ? data.is_available : 1, data.has_recipe || 0
      ]);
      const prodId = resDb.lastInsertRowid;
      await db.execute(`
        INSERT INTO product_history (product_id, action_type, new_selling_price, new_purchase_cost, changed_by, notes)
        VALUES (?, 'CREATED', ?, ?, ?, 'Product created')
      `, [prodId, data.selling_price, data.purchase_cost || 0, data.user || 'admin']);
      return sendJSON(res, 201, { success: true, id: prodId, code, barcode });
    }

    if (pathname.match(/^\/api\/products\/(\d+)$/) && method === 'PUT') {
      const id = pathname.split('/')[3];
      const data = await parseBody(req);
      const oldProd = await db.queryOne("SELECT * FROM products WHERE id = ?", [id]);
      if (!oldProd) return sendError(res, 404, "Product not found");

      const variantsJson = data.variants ? JSON.stringify(data.variants) : oldProd.variants_json;
      await db.execute(`
        UPDATE products 
        SET name_en = ?, name_ur = ?, barcode = ?, category_id = ?, subcategory = ?, unit = ?,
            kitchen_station = ?, selling_price = ?, purchase_cost = ?, variants_json = ?,
            tax_rate = ?, max_discount = ?, is_available = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        data.name_en || oldProd.name_en, data.name_ur || oldProd.name_ur, data.barcode || oldProd.barcode,
        data.category_id || oldProd.category_id, data.subcategory || oldProd.subcategory, data.unit || oldProd.unit,
        data.kitchen_station || oldProd.kitchen_station, data.selling_price, data.purchase_cost,
        variantsJson, data.tax_rate || 0, data.max_discount || 0,
        data.is_available !== undefined ? data.is_available : oldProd.is_available, id
      ]);

      if (oldProd.selling_price !== parseFloat(data.selling_price) || oldProd.purchase_cost !== parseFloat(data.purchase_cost)) {
        await db.execute(`
          INSERT INTO product_history (product_id, action_type, old_selling_price, new_selling_price, old_purchase_cost, new_purchase_cost, changed_by, notes)
          VALUES (?, 'PRICE_CHANGED', ?, ?, ?, ?, ?, 'Price or cost updated')
        `, [id, oldProd.selling_price, data.selling_price, oldProd.purchase_cost, data.purchase_cost, data.user || 'admin']);
      }
      return sendJSON(res, 200, { success: true });
    }

    if (pathname.match(/^\/api\/products\/(\d+)\/archive$/) && method === 'PATCH') {
      const id = pathname.split('/')[3];
      const { archive } = await parseBody(req);
      const flag = archive ? 1 : 0;
      await db.execute("UPDATE products SET is_archived = ?, is_available = ? WHERE id = ?", [flag, flag ? 0 : 1, id]);
      await db.execute("INSERT INTO product_history (product_id, action_type, notes) VALUES (?, ?, ?)", [id, flag ? 'ARCHIVED' : 'RESTORED', flag ? 'Archived product' : 'Restored product']);
      return sendJSON(res, 200, { success: true, is_archived: flag });
    }

    if (pathname === '/api/products/history' && method === 'GET') {
      const history = await db.query(`
        SELECT ph.*, p.name_en, p.code
        FROM product_history ph
        JOIN products p ON ph.product_id = p.id
        ORDER BY ph.id DESC LIMIT 100
      `);
      return sendJSON(res, 200, { success: true, history });
    }

    // ----------------------------------------------------
    // 4. ADVANCED POS & ORDER MANAGEMENT (MERGE, TRANSFER, SPLIT, REFUND/CANCEL)
    // ----------------------------------------------------
    if (pathname === '/api/orders' && method === 'GET') {
      const orders = await db.query(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
        FROM orders o ORDER BY o.id DESC LIMIT 100
      `);
      return sendJSON(res, 200, { success: true, orders });
    }

    if (pathname === '/api/orders' && method === 'POST') {
      const body = await parseBody(req);
      const {
        order_type, table_number, customer_id, customer_name, customer_phone,
        items, discount_type, discount_value, payment_method, payments,
        special_instructions, waiter_name, cashier_name, status, prep_status
      } = body;

      if (!items || !items.length) return sendError(res, 400, "Order must have at least one item.");

      let subtotal = 0;
      let complimentaryAmount = 0;
      for (const it of items) {
        if (it.is_complimentary) {
          complimentaryAmount += (it.unit_price * it.quantity);
        } else {
          subtotal += (it.unit_price * it.quantity);
        }
      }

      let discountAmount = 0;
      if (discount_type === 'percent' && discount_value > 0) {
        discountAmount = Math.round((subtotal * discount_value) / 100);
      } else if (discount_type === 'fixed' && discount_value > 0) {
        discountAmount = Math.min(subtotal, discount_value);
      }

      const grandTotal = Math.max(0, subtotal - discountAmount);
      const isPaid = (payment_method && payment_method !== 'unpaid' && status === 'completed');
      const paymentStatus = isPaid ? (payment_method === 'udhaar' ? 'udhaar' : 'paid') : 'unpaid';
      const orderStatus = status || (isPaid ? 'completed' : 'pending');
      const { orderNumber, dailySeq } = await services.generateOrderNumber();

      const orderRes = await db.execute(`
        INSERT INTO orders (
          order_number, daily_seq, order_type, table_number, customer_id, customer_name, customer_phone,
          status, prep_status, subtotal, discount_type, discount_value, discount_amount, complimentary_amount,
          tax_amount, grand_total, payment_status, payment_method, special_instructions, waiter_name, cashier_name, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, ?, ?, ?, ?, ?)
      `, [
        orderNumber, dailySeq, order_type || 'dine_in', table_number || '', customer_id || null,
        customer_name || 'Walk-in Customer', customer_phone || '', orderStatus, prep_status || (orderStatus === 'completed' ? 'completed' : 'preparing'),
        subtotal, discount_type || 'none', discount_value || 0, discountAmount, complimentaryAmount,
        grandTotal, paymentStatus, payment_method || 'cash', special_instructions || '',
        waiter_name || 'Asad Waiter', cashier_name || 'Tariq Cashier', orderStatus === 'completed' ? new Date().toISOString() : null
      ]);

      const orderId = orderRes.lastInsertRowid;

      for (const it of items) {
        const prod = await db.queryOne("SELECT name_en, name_ur, kitchen_station FROM products WHERE id = ?", [it.product_id]);
        const nameEn = prod ? prod.name_en : (it.name_en || 'Product');
        const nameUr = prod ? prod.name_ur : (it.name_ur || '');
        const station = prod ? prod.kitchen_station : (it.kitchen_station || 'Main Kitchen');
        const totalPrice = it.is_complimentary ? 0 : (it.unit_price * it.quantity);

        await db.execute(`
          INSERT INTO order_items (
            order_id, product_id, product_name_en, product_name_ur, variant_name, kitchen_station,
            quantity, unit_price, total_price, is_complimentary, special_instructions
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          orderId, it.product_id, nameEn, nameUr, it.variant_name || 'Standard', station,
          it.quantity, it.unit_price, totalPrice, it.is_complimentary ? 1 : 0, it.special_instructions || ''
        ]);
      }

      // Record Payments & Double-Entry Accounting
      const drMap = { cash: '1010', bank: '1020', easypaisa: '1030', jazzcash: '1040', udhaar: '1100' };
      if (payments && payments.length > 0) {
        for (const p of payments) {
          await db.execute("INSERT INTO order_payments (order_id, payment_method, amount, reference_number) VALUES (?, ?, ?, ?)", [orderId, p.payment_method, p.amount, p.reference_number || '']);
          if (p.payment_method === 'udhaar' && customer_id) {
            await services.recordUdhaarSale(customer_id, orderId, p.amount, orderNumber);
          }
          await accounting.postJournalEntry({
            description: `Order #${orderNumber} split payment (${p.payment_method})`,
            debitCode: drMap[p.payment_method] || '1010',
            creditCode: '4010',
            amount: p.amount,
            paymentMethod: p.payment_method,
            referenceNo: orderNumber,
            relatedOrderId: orderId,
            enteredBy: cashier_name || 'cashier'
          });
        }
      } else if (isPaid && payment_method && grandTotal > 0) {
        await db.execute("INSERT INTO order_payments (order_id, payment_method, amount, reference_number) VALUES (?, ?, ?, '')", [orderId, payment_method, grandTotal]);
        if (payment_method === 'udhaar' && customer_id) {
          await services.recordUdhaarSale(customer_id, orderId, grandTotal, orderNumber);
        }
        await accounting.postJournalEntry({
          description: `Order #${orderNumber} sale (${payment_method})`,
          debitCode: drMap[payment_method] || '1010',
          creditCode: '4010',
          amount: grandTotal,
          paymentMethod: payment_method,
          referenceNo: orderNumber,
          relatedOrderId: orderId,
          enteredBy: cashier_name || 'cashier'
        });
      }

      const kots = await services.generateKOTsForOrder(orderId);
      if (orderStatus === 'completed') {
        await services.deductRecipeInventoryForOrder(orderId);
      }

      return sendJSON(res, 201, { success: true, orderId, orderNumber, dailySeq, grandTotal, kots });
    }

    // CANCEL OR REFUND ORDER WITH STOCK & ACCOUNTING REVERSAL
    if (pathname.match(/^\/api\/orders\/(\d+)\/(cancel|refund)$/) && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[3];
      const action = parts[4]; // 'cancel' or 'refund'
      const { reason, user } = await parseBody(req);

      await services.reverseOrderInventoryAndAccounting(orderId, reason || `Order ${action}ed`, user || 'admin');
      await db.execute(`
        UPDATE orders
        SET status = 'cancelled',
            prep_status = 'cancelled',
            refund_reason = ?,
            refund_amount = grand_total
        WHERE id = ?
      `, [reason || `Order ${action}ed`, orderId]);

      await db.execute("INSERT INTO audit_logs (user_name, role, action, details) VALUES (?, 'admin', ?, ?)", [
        user || 'admin', action.toUpperCase() + '_ORDER', `Order ID #${orderId} ${action}ed: ${reason || 'N/A'}`
      ]);

      return sendJSON(res, 200, { success: true, message: `Order #${orderId} ${action}ed; stock and accounting entries reversed.` });
    }

    // UPDATE KITCHEN PREPARATION STATUS OR TABLE TRANSFER
    if (pathname.match(/^\/api\/orders\/(\d+)\/status$/) && method === 'PATCH') {
      const orderId = pathname.split('/')[3];
      const { prep_status, table_number, user } = await parseBody(req);
      const order = await db.queryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
      if (!order) return sendError(res, 404, "Order not found");

      const hist = JSON.parse(order.modification_history_json || '[]');
      if (table_number && table_number !== order.table_number) {
        hist.push({ type: 'TABLE_TRANSFER', from: order.table_number, to: table_number, by: user || 'waiter', at: services.getPSTDateString() });
      }
      if (prep_status && prep_status !== order.prep_status) {
        hist.push({ type: 'PREP_STATUS', from: order.prep_status, to: prep_status, by: user || 'kitchen', at: services.getPSTDateString() });
      }

      await db.execute(`
        UPDATE orders
        SET prep_status = COALESCE(?, prep_status),
            table_number = COALESCE(?, table_number),
            modification_history_json = ?
        WHERE id = ?
      `, [prep_status, table_number, JSON.stringify(hist), orderId]);
      return sendJSON(res, 200, { success: true, history: hist });
    }

    // ----------------------------------------------------
    // 5. RECEIPT, KOT & ESC/POS HARDWARE PAYLOAD
    // ----------------------------------------------------
    if (pathname.match(/^\/api\/orders\/(\d+)\/receipt$/) && method === 'GET') {
      const orderId = pathname.split('/')[3];
      const receiptData = await services.getCustomerReceiptData(orderId);
      const escposBase64 = escposBridge.buildEscPosCustomerReceipt(receiptData, {
        paperWidth: query.width || '80mm',
        openCashDrawer: true,
        autoCut: true
      });
      return sendJSON(res, 200, { success: true, receipt: receiptData, escposBase64 });
    }

    if (pathname.match(/^\/api\/orders\/(\d+)\/kot$/) && method === 'GET') {
      const orderId = pathname.split('/')[3];
      const kots = await services.generateKOTsForOrder(orderId);
      return sendJSON(res, 200, { success: true, kots });
    }

    // ----------------------------------------------------
    // 6. COMPLETE INVENTORY, STOCK REGISTER & RECONCILIATION
    // ----------------------------------------------------
    if (pathname === '/api/inventory' && method === 'GET') {
      const items = await db.query(`
        SELECT inv.*, s.name as supplier_name,
               (inv.current_stock * inv.purchase_cost_per_unit) as valuation
        FROM inventory_items inv
        LEFT JOIN suppliers s ON inv.supplier_id = s.id
        ORDER BY inv.name_en ASC
      `);
      return sendJSON(res, 200, { success: true, inventory: items });
    }

    if (pathname === '/api/inventory/movements' && method === 'GET') {
      const movements = await db.query(`
        SELECT st.*, inv.code, inv.name_en, inv.unit
        FROM stock_transactions st
        JOIN inventory_items inv ON st.inventory_item_id = inv.id
        ORDER BY st.id DESC LIMIT 150
      `);
      return sendJSON(res, 200, { success: true, movements });
    }

    if (pathname === '/api/inventory/reconcile' && method === 'POST') {
      const { inventory_item_id, physical_counted, reason, is_damaged, user } = await parseBody(req);
      const item = await db.queryOne("SELECT * FROM inventory_items WHERE id = ?", [inventory_item_id]);
      if (!item) return sendError(res, 404, "Inventory item not found");

      const counted = parseFloat(physical_counted);
      const variance = +(counted - item.current_stock).toFixed(4);

      const statements = [
        {
          sql: `INSERT INTO stock_reconciliations (inventory_item_id, system_stock, physical_counted, variance, reason, reconciled_by)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [inventory_item_id, item.current_stock, counted, variance, reason || 'Physical stock count', user || 'admin']
        },
        {
          sql: `INSERT INTO stock_transactions (inventory_item_id, transaction_type, quantity, reference_id, notes)
                VALUES (?, ?, ?, 'RECONCILE', ?)`,
          params: [inventory_item_id, is_damaged ? 'waste' : 'adjustment', variance, reason || 'Stock reconciliation']
        }
      ];

      if (is_damaged && variance < 0) {
        statements.push({
          sql: `UPDATE inventory_items
                SET damaged_qty = damaged_qty + ?, current_stock = ?, last_updated = CURRENT_TIMESTAMP
                WHERE id = ?`,
          params: [Math.abs(variance), counted, inventory_item_id]
        });
      } else {
        statements.push({
          sql: `UPDATE inventory_items SET current_stock = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
          params: [counted, inventory_item_id]
        });
      }

      await db.transaction(statements);
      return sendJSON(res, 200, { success: true, variance, newStock: counted });
    }

    // ----------------------------------------------------
    // 7. COMPLETE SUPPLIER MANAGEMENT (GRN, PO, RETURNS, LEDGER)
    // ----------------------------------------------------
    if (pathname === '/api/suppliers' && method === 'GET') {
      const suppliers = await db.query("SELECT * FROM suppliers ORDER BY payable_balance DESC, name ASC");
      return sendJSON(res, 200, { success: true, suppliers });
    }

    if (pathname === '/api/suppliers' && method === 'POST') {
      const body = await parseBody(req);
      const ob = parseFloat(body.opening_balance) || 0;
      const resDb = await db.execute(`
        INSERT INTO suppliers (name, phone, address, contact_person, opening_balance, total_purchases, total_payments, payable_balance)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `, [body.name, body.phone || '', body.address || '', body.contact_person || '', ob, ob, ob]);
      const supId = resDb.lastInsertRowid;
      if (ob > 0) {
        await db.execute(`
          INSERT INTO supplier_ledger (supplier_id, transaction_type, debit_amount, credit_amount, balance_after, reference_no, notes)
          VALUES (?, 'opening_balance', 0, ?, ?, 'OPEN-SUP', 'Opening supplier payable')
        `, [supId, ob, ob]);
      }
      return sendJSON(res, 201, { success: true, id: supId });
    }

    if (pathname === '/api/suppliers/purchase' && method === 'POST') {
      const body = await parseBody(req);
      const result = await services.recordSupplierPurchaseInvoice({
        supplierId: body.supplier_id,
        docType: body.doc_type || 'GRN',
        items: body.items || [],
        paidAmount: body.paid_amount || 0,
        paymentMethod: body.payment_method || 'cash',
        notes: body.notes || '',
        enteredBy: body.user || 'admin'
      });
      return sendJSON(res, 201, { success: true, ...result });
    }

    if (pathname.match(/^\/api\/suppliers\/(\d+)\/pay$/) && method === 'POST') {
      const supplierId = pathname.split('/')[3];
      const { amount, payment_method, notes, user } = await parseBody(req);
      const result = await services.recordSupplierPayment(supplierId, amount, payment_method || 'cash', notes, user || 'admin');
      return sendJSON(res, 200, { success: true, result });
    }

    if (pathname.match(/^\/api\/suppliers\/(\d+)\/ledger$/) && method === 'GET') {
      const supplierId = pathname.split('/')[3];
      const supplier = await db.queryOne("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
      const ledger = await db.query("SELECT * FROM supplier_ledger WHERE supplier_id = ? ORDER BY id DESC", [supplierId]);
      const invoices = await db.query("SELECT * FROM purchase_invoices WHERE supplier_id = ? ORDER BY id DESC", [supplierId]);
      return sendJSON(res, 200, { success: true, supplier, ledger, invoices });
    }

    // ----------------------------------------------------
    // 8. DOUBLE-ENTRY ACCOUNTING & FINANCIAL STATEMENTS
    // ----------------------------------------------------
    if (pathname === '/api/accounting/trial-balance' && method === 'GET') {
      const tb = await accounting.getTrialBalance();
      const journal = await db.query("SELECT * FROM accounting_journal ORDER BY id DESC LIMIT 200");
      return sendJSON(res, 200, { success: true, trialBalance: tb, journal });
    }

    if (pathname === '/api/accounting/journal' && method === 'POST') {
      const body = await parseBody(req);
      const voucherNo = await accounting.postJournalEntry({
        description: body.description,
        debitCode: body.debit_code,
        creditCode: body.credit_code,
        amount: parseFloat(body.amount),
        paymentMethod: body.payment_method || 'cash',
        referenceNo: body.reference_no || 'MANUAL-JV',
        enteredBy: body.user || 'admin'
      });
      return sendJSON(res, 201, { success: true, voucherNo });
    }

    if (pathname === '/api/accounting/daily-summary' && method === 'GET') {
      const start = query.start_date || services.getPSTDateOnly();
      const end = query.end_date || services.getPSTDateOnly();
      const summary = await accounting.getFinancialSummary(start, end);
      return sendJSON(res, 200, { success: true, ...summary });
    }

    // ----------------------------------------------------
    // 9. CUSTOMERS & UDHAAR LEDGER
    // ----------------------------------------------------
    if (pathname === '/api/customers' && method === 'GET') {
      const customers = await db.query("SELECT * FROM customers ORDER BY current_balance DESC, name ASC");
      return sendJSON(res, 200, { success: true, customers });
    }

    if (pathname === '/api/customers' && method === 'POST') {
      const body = await parseBody(req);
      const opening = parseFloat(body.opening_balance) || 0;
      const resDb = await db.execute(`
        INSERT INTO customers (name, phone, address, opening_balance, current_balance, total_purchased, credit_limit, discount_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [body.name, body.phone, body.address || '', opening, opening, opening, body.credit_limit || 20000, body.discount_percent || 0]);
      const customerId = resDb.lastInsertRowid;
      if (opening > 0) {
        await db.execute("INSERT INTO customer_ledger (customer_id, transaction_type, amount, balance_after, notes) VALUES (?, 'opening_balance', ?, ?, 'Opening Udhaar Balance')", [customerId, opening, opening]);
      }
      return sendJSON(res, 201, { success: true, id: customerId });
    }

    if (pathname.match(/^\/api\/customers\/(\d+)\/pay$/) && method === 'POST') {
      const customerId = pathname.split('/')[3];
      const { amount, payment_method, notes, user } = await parseBody(req);
      const result = await services.recordCustomerPayment(customerId, parseFloat(amount), payment_method || 'cash', notes, user || 'admin');
      return sendJSON(res, 200, { success: true, result });
    }

    // ----------------------------------------------------
    // 10. EXPENSES & ACCOUNTING POSTING
    // ----------------------------------------------------
    if (pathname === '/api/expenses' && method === 'GET') {
      const expenses = await db.query("SELECT * FROM expenses ORDER BY expense_date DESC, id DESC");
      return sendJSON(res, 200, { success: true, expenses });
    }

    if (pathname === '/api/expenses' && method === 'POST') {
      const body = await parseBody(req);
      const amt = parseFloat(body.amount) || 0;
      const method = body.payment_method || 'cash';
      const resDb = await db.execute(`
        INSERT INTO expenses (title, category, amount, payment_method, expense_date, paid_to, reference_number, payment_status, is_recurring, description, is_inventory_purchase)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        body.title, body.category || 'Other', amt, method, body.expense_date || services.getPSTDateOnly(),
        body.paid_to || 'Vendor', body.reference_number || '', body.payment_status || 'paid',
        body.is_recurring ? 1 : 0, body.description || '', body.is_inventory_purchase ? 1 : 0
      ]);

      // Post Double-Entry Journal: Dr Operating Expenses (5020) or Inventory (1200) / Cr Cash or Bank
      const crMap = { cash: '1010', bank: '1020', easypaisa: '1030', jazzcash: '1040' };
      const drCode = body.is_inventory_purchase ? '1200' : '5020';
      await accounting.postJournalEntry({
        description: `Expense: ${body.title} (${body.category})`,
        debitCode: drCode,
        creditCode: crMap[method] || '1010',
        amount: amt,
        paymentMethod: method,
        referenceNo: body.reference_number || `EXP-${resDb.lastInsertRowid}`,
        enteredBy: body.user || 'admin'
      });

      return sendJSON(res, 201, { success: true, id: resDb.lastInsertRowid });
    }

    // ----------------------------------------------------
    // 11. DAILY CASH BOOK, CLOSING & SHIFT MANAGEMENT
    // ----------------------------------------------------
    if (pathname === '/api/cashbook/today' && method === 'GET') {
      const cashbook = await services.getDailyCashBook();
      const shifts = await db.query("SELECT * FROM shifts ORDER BY id DESC LIMIT 20");
      return sendJSON(res, 200, { success: true, cashbook, shifts });
    }

    if (pathname === '/api/cashbook/close' && method === 'POST') {
      const { actual_cash, closed_by, notes, date } = await parseBody(req);
      const dateStr = date || services.getPSTDateOnly();
      const closed = await services.closeDailyCashBook(dateStr, parseFloat(actual_cash), closed_by || 'admin', notes || '');
      return sendJSON(res, 200, { success: true, closing: closed });
    }

    // ----------------------------------------------------
    // 12. AUTOMATIC & MANUAL BACKUPS
    // ----------------------------------------------------
    if (pathname === '/api/backup/create' && method === 'POST') {
      const out = await backupScheduler.runBackupProcess('manual');
      const logs = await db.query("SELECT * FROM backup_logs ORDER BY id DESC LIMIT 30");
      return sendJSON(res, 200, { success: true, output: out, logs });
    }

    if (pathname === '/api/backup/list' && method === 'GET') {
      const logs = await db.query("SELECT * FROM backup_logs ORDER BY id DESC LIMIT 30");
      return sendJSON(res, 200, { success: true, backups: logs });
    }

    // ----------------------------------------------------
    // 13. SETTINGS & AUDIT LOGS
    // ----------------------------------------------------
    if (pathname === '/api/settings' && method === 'GET') {
      const rows = await db.query("SELECT key, value FROM settings");
      const settings = {};
      rows.forEach(r => { try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; } });
      const auditLogs = await db.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100");
      return sendJSON(res, 200, { success: true, settings, auditLogs });
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const body = await parseBody(req);
      for (const [k, v] of Object.entries(body)) {
        await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [k, JSON.stringify(v)]);
      }
      return sendJSON(res, 200, { success: true });
    }

    // ----------------------------------------------------
    
    // ----------------------------------------------------
    // 14. V3.0 MASTER ADMIN, SUB-ADMIN & STAFF PERFORMANCE / AUDIT
    // ----------------------------------------------------
    if (pathname === '/api/users' && method === 'GET') {
      const users = await db.query('SELECT id, username, full_name, role, role_title, pin_code, is_master_admin, permissions_json, inactivity_timeout_min, total_sales_amount, total_orders_count, last_login_at, is_active FROM users ORDER BY is_master_admin DESC, id ASC');
      const auditLogs = await db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');
      const refundRegister = await db.query('SELECT * FROM refund_wastage_register ORDER BY id DESC LIMIT 100');
      return sendJSON(res, 200, { success: true, users, auditLogs, refundRegister });
    }

    if (pathname === '/api/users' && method === 'POST') {
      const body = await parseBody(req);
      const pwHash = services.hashPassword(body.password || 'admin123');
      const perms = typeof body.permissions === 'string' ? body.permissions : JSON.stringify(body.permissions || {});
      const ins = await db.execute(`
        INSERT INTO users (username, password_hash, full_name, role, role_title, pin_code, is_master_admin, permissions_json, inactivity_timeout_min, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        body.username, pwHash, body.full_name, body.role || 'admin', body.role_title || 'Sub-Admin',
        body.pin_code || '5566', body.is_master_admin ? 1 : 0, perms, body.inactivity_timeout_min || 30, body.created_by || 'masteradmin'
      ]);
      await db.execute(`
        INSERT INTO audit_logs (user_name, full_name, role, action, details, exact_timestamp_pkt)
        VALUES (?, 'Owner / Master Admin', 'Master Admin', 'CREATE_ADMIN_USER', ?, ?)
      `, [body.created_by || 'masteradmin', `Created user account '${body.username}' (${body.role_title})`, services.getPSTDateString()]);
      return sendJSON(res, 201, { success: true, id: ins.lastInsertRowid });
    }

    // STATIC FRONTEND SERVING
    // ----------------------------------------------------
    if (pathname === '/' || pathname === '/index.html') {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(indexPath).pipe(res);
      }
    }

    sendError(res, 404, `Endpoint ${method} ${pathname} not found.`);
  } catch (err) {
    console.error(`[Server Error]:`, err);
    sendError(res, 500, err.message || "Internal server error");
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[ROOMI CAFE POS v2.0] Server listening on port ${PORT}`);
    console.log(`[PST Time] ${services.getPSTDateString()}`);
  });
}

module.exports = server;
