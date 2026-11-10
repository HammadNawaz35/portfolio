/**
 * Upgraded Core Business Services (v2.0) for ROOMI CAFE POS & Management System.
 * Preserves all v1 functionality and adds:
 * - Complete Stock & Inventory Register tracking (Opening, Purchased, Consumed, Returned, Damaged)
 * - Automatic stock & accounting reversal on Order Cancellation or Refund
 * - Double-Entry Accounting journal entries on every sale, collection, purchase, supplier payment, expense, and owner transaction
 * - Complete Supplier Purchase Orders / GRN / Returns & Supplier Ledger
 * - Shift Management & Reopen audit controls
 */

const db = require('./db');
const crypto = require('crypto');
const accounting = require('./accounting');

function hashPassword(password) {
  const salt = "roomi_cafe_2026_secure_salt";
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function getPSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date);
}

function getPSTDateOnly(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

async function generateOrderNumber() {
  const todayStr = getPSTDateOnly();
  const dateKey = todayStr.replace(/-/g, '');
  const row = await db.queryOne(`
    SELECT COUNT(*) as count FROM orders 
    WHERE DATE(created_at, '+5 hours') = DATE('now', '+5 hours')
       OR order_number LIKE ?
  `, [`RC-${dateKey}-%`]);
  const seq = (row ? row.count : 0) + 1;
  const seqStr = String(seq).padStart(3, '0');
  return { orderNumber: `RC-${dateKey}-${seqStr}`, dailySeq: seq };
}

/**
 * Deduct recipe inventory items for an order and update consumed_qty in the permanent stock register.
 */
async function deductRecipeInventoryForOrder(orderId) {
  const order = await db.queryOne("SELECT id, order_number, is_stock_deducted FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Order not found");
  if (order.is_stock_deducted) {
    return { success: true, message: "Inventory already deducted for this order." };
  }

  const items = await db.query("SELECT product_id, quantity FROM order_items WHERE order_id = ?", [orderId]);
  const statements = [];

  for (const item of items) {
    const recipes = await db.query(`
      SELECT r.inventory_item_id, r.quantity_required, inv.name_en, inv.current_stock
      FROM recipes r
      JOIN inventory_items inv ON r.inventory_item_id = inv.id
      WHERE r.product_id = ?
    `, [item.product_id]);

    for (const r of recipes) {
      const totalDeduct = +(r.quantity_required * item.quantity).toFixed(4);
      statements.push({
        sql: `INSERT INTO stock_transactions 
              (inventory_item_id, transaction_type, quantity, unit_cost, total_amount, reference_id, notes)
              VALUES (?, 'sale_deduction', ?, 0, 0, ?, ?)`,
        params: [r.inventory_item_id, totalDeduct, `ORDER-${order.order_number}`, `Recipe deduction for Order #${order.order_number}`]
      });
      statements.push({
        sql: `UPDATE inventory_items 
              SET consumed_qty = consumed_qty + ?,
                  current_stock = current_stock - ?,
                  last_updated = CURRENT_TIMESTAMP 
              WHERE id = ?`,
        params: [totalDeduct, totalDeduct, r.inventory_item_id]
      });
    }
  }

  statements.push({
    sql: "UPDATE orders SET is_stock_deducted = 1 WHERE id = ?",
    params: [orderId]
  });

  if (statements.length > 0) {
    await db.transaction(statements);
  }
  return { success: true, count: items.length };
}

/**
 * Reverse recipe inventory deduction & accounting when an order is cancelled or refunded.
 */
async function reverseOrderInventoryAndAccounting(orderId, reason = 'Order cancelled/refunded', user = 'admin') {
  const order = await db.queryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Order not found");

  const statements = [];

  // 1. Reverse stock if it was deducted
  if (order.is_stock_deducted === 1) {
    const items = await db.query("SELECT product_id, quantity FROM order_items WHERE order_id = ?", [orderId]);
    for (const item of items) {
      const recipes = await db.query("SELECT inventory_item_id, quantity_required FROM recipes WHERE product_id = ?", [item.product_id]);
      for (const r of recipes) {
        const reverseQty = +(r.quantity_required * item.quantity).toFixed(4);
        statements.push({
          sql: `INSERT INTO stock_transactions (inventory_item_id, transaction_type, quantity, reference_id, notes)
                VALUES (?, 'adjustment', ?, ?, ?)`,
          params: [r.inventory_item_id, reverseQty, `REV-${order.order_number}`, `Stock reversal: ${reason}`]
        });
        statements.push({
          sql: `UPDATE inventory_items
                SET consumed_qty = MAX(0, consumed_qty - ?),
                    current_stock = current_stock + ?,
                    last_updated = CURRENT_TIMESTAMP
                WHERE id = ?`,
          params: [reverseQty, reverseQty, r.inventory_item_id]
        });
      }
    }
    statements.push({
      sql: "UPDATE orders SET is_stock_deducted = 0 WHERE id = ?",
      params: [orderId]
    });
  }

  // 2. Reverse customer Udhaar if order was on credit
  if (order.payment_method === 'udhaar' && order.customer_id && order.grand_total > 0) {
    const cust = await db.queryOne("SELECT current_balance, total_purchased FROM customers WHERE id = ?", [order.customer_id]);
    if (cust) {
      const newBal = Math.max(0, cust.current_balance - order.grand_total);
      const newTot = Math.max(0, cust.total_purchased - order.grand_total);
      statements.push({
        sql: "UPDATE customers SET current_balance = ?, total_purchased = ? WHERE id = ?",
        params: [newBal, newTot, order.customer_id]
      });
      statements.push({
        sql: `INSERT INTO customer_ledger (customer_id, transaction_type, amount, balance_after, reference_order_id, notes)
              VALUES (?, 'adjustment', ?, ?, ?, ?)`,
        params: [order.customer_id, -order.grand_total, newBal, order.id, `Reversal for cancelled Order #${order.order_number}`]
      });
    }
  }

  if (statements.length > 0) {
    await db.transaction(statements);
  }

  // 3. Reverse Double-Entry Accounting (Dr Sales Revenue 4010 / Cr Asset or Receivable)
  if (order.payment_status === 'paid' || order.payment_status === 'udhaar') {
    const accMap = {
      cash: '1010',
      bank: '1020',
      easypaisa: '1030',
      jazzcash: '1040',
      udhaar: '1100'
    };
    const crCode = accMap[order.payment_method] || '1010';
    await accounting.postJournalEntry({
      description: `Reversal/Refund for Order #${order.order_number} (${reason})`,
      debitCode: '4010',
      creditCode: crCode,
      amount: order.grand_total,
      paymentMethod: order.payment_method,
      referenceNo: `REV-${order.order_number}`,
      relatedOrderId: order.id,
      enteredBy: user
    });
  }

  return { success: true };
}

async function recordUdhaarSale(customerId, orderId, amount, orderNumber) {
  if (!customerId || amount <= 0) return;
  const cust = await db.queryOne("SELECT id, name, current_balance, total_purchased, loyalty_points FROM customers WHERE id = ?", [customerId]);
  if (!cust) throw new Error(`Customer with ID ${customerId} not found`);

  const newBalance = (cust.current_balance || 0) + amount;
  const newTotalPurchased = (cust.total_purchased || 0) + amount;
  const earnedPoints = Math.floor(amount / 100);

  await db.transaction([
    {
      sql: "UPDATE customers SET current_balance = ?, total_purchased = ?, loyalty_points = loyalty_points + ? WHERE id = ?",
      params: [newBalance, newTotalPurchased, earnedPoints, customerId]
    },
    {
      sql: `INSERT INTO customer_ledger 
            (customer_id, transaction_type, amount, balance_after, reference_order_id, notes)
            VALUES (?, 'credit_sale', ?, ?, ?, ?)`,
      params: [customerId, amount, newBalance, orderId, `Credit sale for Order #${orderNumber}`]
    }
  ]);
}

async function recordCustomerPayment(customerId, amount, paymentMethod = 'cash', notes = '', enteredBy = 'admin') {
  if (!customerId || amount <= 0) throw new Error("Invalid customer or payment amount");
  const cust = await db.queryOne("SELECT id, name, current_balance FROM customers WHERE id = ?", [customerId]);
  if (!cust) throw new Error("Customer not found");

  const newBalance = (cust.current_balance || 0) - amount;

  await db.transaction([
    {
      sql: "UPDATE customers SET current_balance = ? WHERE id = ?",
      params: [newBalance, customerId]
    },
    {
      sql: `INSERT INTO customer_ledger 
            (customer_id, transaction_type, amount, balance_after, payment_method, notes)
            VALUES (?, 'payment_received', ?, ?, ?, ?)`,
      params: [customerId, amount, newBalance, paymentMethod, notes || `Payment received via ${paymentMethod}`]
    }
  ]);

  // Post Double-Entry Journal: Dr Cash/Bank/Wallet, Cr Customer Receivables (1100)
  const drMap = { cash: '1010', bank: '1020', easypaisa: '1030', jazzcash: '1040' };
  const debitCode = drMap[paymentMethod] || '1010';
  await accounting.postJournalEntry({
    description: `Udhaar recovery from ${cust.name}`,
    debitCode,
    creditCode: '1100',
    amount,
    paymentMethod,
    referenceNo: `CUST-PAY-${customerId}`,
    enteredBy
  });

  if (paymentMethod === 'cash') {
    const todayStr = getPSTDateOnly();
    await db.execute(`
      UPDATE cash_closings 
      SET cash_from_udhaar = cash_from_udhaar + ?,
          expected_cash = opening_cash + cash_sales + cash_from_udhaar + ? - cash_expenses - cash_withdrawals
      WHERE closing_date = ? AND status = 'open'
    `, [amount, amount, todayStr]);
  }

  return { customerId, customerName: cust.name, amountReceived: amount, newBalance, paymentMethod };
}

/**
 * Record Supplier Purchase Invoice / GRN & update Stock Register + Supplier Ledger + Accounting.
 */
async function recordSupplierPurchaseInvoice({
  supplierId,
  docType = 'GRN',
  items = [], // [{ inventory_item_id, name_en, qty, rate }]
  paidAmount = 0,
  paymentMethod = 'cash',
  notes = '',
  enteredBy = 'admin'
}) {
  const sup = await db.queryOne("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
  if (!sup) throw new Error("Supplier not found");

  let totalAmount = 0;
  for (const it of items) {
    totalAmount += (parseFloat(it.qty) * parseFloat(it.rate));
  }
  const paid = parseFloat(paidAmount) || 0;
  const balanceDue = Math.max(0, totalAmount - paid);
  const invNo = `${docType}-${getPSTDateOnly().replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;

  const statements = [
    {
      sql: `INSERT INTO purchase_invoices (
              invoice_number, doc_type, supplier_id, supplier_name, items_json,
              total_amount, paid_amount, balance_due, payment_method, status, notes, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        invNo, docType, supplierId, sup.name, JSON.stringify(items),
        totalAmount, paid, balanceDue, paymentMethod, docType === 'RETURN' ? 'returned' : 'received', notes, enteredBy
      ]
    }
  ];

  // Update Stock Register for each item
  for (const it of items) {
    const qty = parseFloat(it.qty);
    const rate = parseFloat(it.rate);
    if (docType === 'RETURN') {
      statements.push({
        sql: `UPDATE inventory_items
              SET returned_qty = returned_qty + ?,
                  current_stock = current_stock - ?,
                  last_updated = CURRENT_TIMESTAMP
              WHERE id = ?`,
        params: [qty, qty, it.inventory_item_id]
      });
      statements.push({
        sql: `INSERT INTO stock_transactions (inventory_item_id, transaction_type, quantity, unit_cost, total_amount, reference_id, notes)
              VALUES (?, 'adjustment', ?, ?, ?, ?, 'Purchase return to supplier')`,
        params: [it.inventory_item_id, -qty, rate, qty * rate, invNo]
      });
    } else {
      statements.push({
        sql: `UPDATE inventory_items
              SET purchased_qty = purchased_qty + ?,
                  current_stock = current_stock + ?,
                  purchase_cost_per_unit = ?,
                  supplier_id = ?,
                  last_purchase_date = DATE('now'),
                  last_updated = CURRENT_TIMESTAMP
              WHERE id = ?`,
        params: [qty, qty, rate, supplierId, it.inventory_item_id]
      });
      statements.push({
        sql: `INSERT INTO stock_transactions (inventory_item_id, transaction_type, quantity, unit_cost, total_amount, reference_id, notes)
              VALUES (?, 'purchase', ?, ?, ?, ?, ?)`,
        params: [it.inventory_item_id, qty, rate, qty * rate, invNo, notes || `GRN from ${sup.name}`]
      });
    }
  }

  // Update Supplier Balance & Ledger
  if (docType === 'RETURN') {
    const newPayable = Math.max(0, sup.payable_balance - totalAmount);
    statements.push({
      sql: "UPDATE suppliers SET payable_balance = ? WHERE id = ?",
      params: [newPayable, supplierId]
    });
    statements.push({
      sql: `INSERT INTO supplier_ledger (supplier_id, transaction_type, debit_amount, credit_amount, balance_after, reference_no, notes)
            VALUES (?, 'purchase_return', ?, 0, ?, ?, ?)`,
      params: [supplierId, totalAmount, newPayable, invNo, notes || 'Purchase return']
    });
  } else {
    const newPurchases = sup.total_purchases + totalAmount;
    const newPayments = sup.total_payments + paid;
    const newPayable = sup.payable_balance + balanceDue;
    statements.push({
      sql: "UPDATE suppliers SET total_purchases = ?, total_payments = ?, payable_balance = ? WHERE id = ?",
      params: [newPurchases, newPayments, newPayable, supplierId]
    });
    statements.push({
      sql: `INSERT INTO supplier_ledger (supplier_id, transaction_type, debit_amount, credit_amount, balance_after, reference_no, payment_method, notes)
            VALUES (?, 'purchase_invoice', ?, ?, ?, ?, ?, ?)`,
      params: [supplierId, paid, totalAmount, newPayable, invNo, paymentMethod, notes || `GRN Invoice ${invNo}`]
    });
  }

  await db.transaction(statements);

  // Double-Entry Accounting
  const payAccMap = { cash: '1010', bank: '1020', easypaisa: '1030', jazzcash: '1040' };
  const assetCode = payAccMap[paymentMethod] || '1010';

  if (docType === 'RETURN') {
    await accounting.postJournalEntry({
      description: `Purchase return ${invNo} to ${sup.name}`,
      debitCode: '2010',
      creditCode: '1200',
      amount: totalAmount,
      paymentMethod: 'credit',
      referenceNo: invNo,
      enteredBy
    });
  } else {
    if (paid > 0) {
      await accounting.postJournalEntry({
        description: `Stock purchase ${invNo} from ${sup.name} (Paid portion)`,
        debitCode: '1200',
        creditCode: assetCode,
        amount: paid,
        paymentMethod,
        referenceNo: invNo,
        enteredBy
      });
    }
    if (balanceDue > 0) {
      await accounting.postJournalEntry({
        description: `Stock purchase ${invNo} from ${sup.name} (Credit payable)`,
        debitCode: '1200',
        creditCode: '2010',
        amount: balanceDue,
        paymentMethod: 'credit',
        referenceNo: invNo,
        enteredBy
      });
    }
  }

  return { invoiceNumber: invNo, totalAmount, paidAmount: paid, balanceDue };
}

/**
 * Record Payment to Supplier against Outstanding Payable.
 */
async function recordSupplierPayment(supplierId, amount, paymentMethod = 'cash', notes = '', enteredBy = 'admin') {
  const sup = await db.queryOne("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
  if (!sup) throw new Error("Supplier not found");
  const payAmt = parseFloat(amount);
  if (!payAmt || payAmt <= 0) throw new Error("Invalid payment amount");

  const newPayable = Math.max(0, sup.payable_balance - payAmt);
  const newPayments = sup.total_payments + payAmt;
  const refNo = `SUP-PAY-${Date.now().toString().slice(-5)}`;

  await db.transaction([
    {
      sql: "UPDATE suppliers SET total_payments = ?, payable_balance = ? WHERE id = ?",
      params: [newPayments, newPayable, supplierId]
    },
    {
      sql: `INSERT INTO supplier_ledger (supplier_id, transaction_type, debit_amount, credit_amount, balance_after, reference_no, payment_method, notes)
            VALUES (?, 'payment_sent', ?, 0, ?, ?, ?, ?)`,
      params: [supplierId, payAmt, newPayable, refNo, paymentMethod, notes || `Supplier payment via ${paymentMethod}`]
    }
  ]);

  const payAccMap = { cash: '1010', bank: '1020', easypaisa: '1030', jazzcash: '1040' };
  const crCode = payAccMap[paymentMethod] || '1010';

  await accounting.postJournalEntry({
    description: `Payment to supplier ${sup.name}`,
    debitCode: '2010',
    creditCode: crCode,
    amount: payAmt,
    paymentMethod,
    referenceNo: refNo,
    enteredBy
  });

  return { supplierId, supplierName: sup.name, amountPaid: payAmt, newPayable };
}

async function generateKOTsForOrder(orderId) {
  const order = await db.queryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Order not found");

  const items = await db.query(`
    SELECT oi.*, p.kitchen_station
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `, [orderId]);

  const stationGroups = {};
  for (const item of items) {
    const station = item.kitchen_station || 'Main Kitchen';
    if (!stationGroups[station]) stationGroups[station] = [];
    stationGroups[station].push({
      productId: item.product_id,
      nameEn: item.product_name_en,
      nameUr: item.product_name_ur,
      variant: item.variant_name || 'Standard',
      quantity: item.quantity,
      specialInstructions: item.special_instructions || ''
    });
  }

  const generatedTickets = [];
  for (const [station, stationItems] of Object.entries(stationGroups)) {
    const existing = await db.queryOne("SELECT * FROM kot_tickets WHERE order_id = ? AND station = ?", [orderId, station]);
    let ticket;
    if (existing) {
      await db.execute("UPDATE kot_tickets SET print_count = print_count + 1, last_printed_at = CURRENT_TIMESTAMP WHERE id = ?", [existing.id]);
      ticket = {
        ...existing,
        items: JSON.parse(existing.items_json),
        print_count: existing.print_count + 1,
        isReprint: true
      };
    } else {
      const ticketNumber = `KOT-${order.order_number}-${station.replace(/\s+/g, '').toUpperCase().slice(0, 4)}`;
      const itemsJson = JSON.stringify(stationItems);
      const ins = await db.execute(`
        INSERT INTO kot_tickets 
        (ticket_number, order_id, order_number, station, order_type, table_number, items_json, special_instructions, print_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `, [ticketNumber, orderId, order.order_number, station, order.order_type, order.table_number || '', itemsJson, order.special_instructions || '']);
      ticket = {
        id: ins.lastInsertRowid,
        ticketNumber,
        orderId,
        orderNumber: order.order_number,
        station,
        orderType: order.order_type,
        tableNumber: order.table_number,
        items: stationItems,
        specialInstructions: order.special_instructions,
        print_count: 1,
        isReprint: false,
        timestamp: getPSTDateString()
      };
    }
    generatedTickets.push(ticket);
  }
  return generatedTickets;
}

async function getCustomerReceiptData(orderId) {
  const order = await db.queryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Order not found");

  const items = await db.query("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
  const payments = await db.query("SELECT * FROM order_payments WHERE order_id = ?", [orderId]);
  const settingsRows = await db.query("SELECT key, value FROM settings");
  const settings = {};
  for (const r of settingsRows) {
    try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
  }

  return {
    cafe: {
      name: settings.restaurant_name || "ROOMI CAFE",
      tagline: settings.tagline || "Authentic Taste, Chai & Fast Food",
      address: settings.address || "Main Commercial Market, Gulberg III, Lahore",
      phone: settings.phone || "+92 300 7666422",
      ntn: settings.ntn || "7864321-9"
    },
    order: {
      id: order.id,
      orderNumber: order.order_number,
      dailySeq: order.daily_seq,
      orderType: order.order_type.toUpperCase(),
      tableNumber: order.table_number || 'N/A',
      customerName: order.customer_name || 'Walk-in',
      customerPhone: order.customer_phone || '',
      waiter: order.waiter_name || 'Counter Staff',
      cashier: order.cashier_name || 'Tariq Cashier',
      status: order.status,
      prepStatus: order.prep_status || 'completed',
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
      createdAt: order.created_at,
      pstFormattedTime: getPSTDateString(new Date(order.created_at))
    },
    items: items.map(i => ({
      nameEn: i.product_name_en,
      nameUr: i.product_name_ur,
      variant: i.variant_name || 'Standard',
      quantity: i.quantity,
      unitPrice: i.unit_price,
      totalPrice: i.total_price,
      isComplimentary: i.is_complimentary === 1,
      specialInstructions: i.special_instructions
    })),
    totals: {
      subtotal: order.subtotal,
      discountType: order.discount_type,
      discountValue: order.discount_value,
      discountAmount: order.discount_amount,
      complimentaryAmount: order.complimentary_amount || 0,
      taxAmount: order.tax_amount,
      grandTotal: order.grand_total,
      currency: "PKR",
      currencySymbol: "Rs."
    },
    payments: payments.map(p => ({
      method: p.payment_method,
      amount: p.amount,
      ref: p.reference_number
    })),
    footer: {
      headerMessage: settings.receipt_header || "WELCOME TO ROOMI CAFE",
      thankYouMessage: settings.receipt_footer || "Thank you for dining with us! Please visit again.",
      softwareCredit: "Software by ROOMI POS (0300-7666422)"
    }
  };
}

async function getDailyCashBook(dateStr = getPSTDateOnly()) {
  let closing = await db.queryOne("SELECT * FROM cash_closings WHERE closing_date = ?", [dateStr]);

  const cashSalesRow = await db.queryOne(`
    SELECT COALESCE(SUM(op.amount), 0) as total
    FROM order_payments op
    JOIN orders o ON op.order_id = o.id
    WHERE op.payment_method = 'cash'
      AND o.status NOT IN ('cancelled', 'refunded')
      AND (DATE(op.created_at, '+5 hours') = ? OR DATE(o.created_at, '+5 hours') = ?)
  `, [dateStr, dateStr]);
  const cashSales = cashSalesRow ? cashSalesRow.total : 0.0;

  const udhaarCashRow = await db.queryOne(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM customer_ledger
    WHERE transaction_type = 'payment_received'
      AND payment_method = 'cash'
      AND DATE(created_at, '+5 hours') = ?
  `, [dateStr]);
  const cashFromUdhaar = udhaarCashRow ? udhaarCashRow.total : 0.0;

  const cashExpensesRow = await db.queryOne(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE payment_method = 'cash'
      AND expense_date = ?
  `, [dateStr]);
  const cashExpenses = cashExpensesRow ? cashExpensesRow.total : 0.0;

  if (!closing) {
    const prevClosing = await db.queryOne(`
      SELECT actual_cash FROM cash_closings 
      WHERE closing_date < ? AND status = 'closed'
      ORDER BY closing_date DESC LIMIT 1
    `, [dateStr]);
    const openingCash = prevClosing ? prevClosing.actual_cash : 5000.0;
    const ins = await db.execute(`
      INSERT INTO cash_closings (
        closing_date, opened_at, opening_cash, cash_sales, cash_from_udhaar,
        cash_expenses, cash_withdrawals, expected_cash, actual_cash, variance, status, notes
      ) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, 0.0, ?, 0.0, 0.0, 'open', 'Daily counter till opening')
    `, [dateStr, openingCash, cashSales, cashFromUdhaar, cashExpenses, (openingCash + cashSales + cashFromUdhaar - cashExpenses)]);
    closing = await db.queryOne("SELECT * FROM cash_closings WHERE id = ?", [ins.lastInsertRowid]);
  } else if (closing.status === 'open') {
    const expected = closing.opening_cash + cashSales + cashFromUdhaar - cashExpenses - (closing.cash_withdrawals || 0);
    await db.execute(`
      UPDATE cash_closings
      SET cash_sales = ?, cash_from_udhaar = ?, cash_expenses = ?, expected_cash = ?
      WHERE id = ?
    `, [cashSales, cashFromUdhaar, cashExpenses, expected, closing.id]);
    closing.cash_sales = cashSales;
    closing.cash_from_udhaar = cashFromUdhaar;
    closing.cash_expenses = cashExpenses;
    closing.expected_cash = expected;
  }

  return closing;
}

async function closeDailyCashBook(dateStr, actualCashCounted, closedByUser = 'admin', notes = '') {
  const closing = await getDailyCashBook(dateStr);
  if (!closing) throw new Error("Cash book record not found for date " + dateStr);
  if (closing.status === 'closed' && closing.is_locked) {
    throw new Error("Day is already closed and locked. Use an adjustment record or authorized reopen.");
  }

  const expected = closing.expected_cash;
  const variance = actualCashCounted - expected;

  await db.execute(`
    UPDATE cash_closings
    SET actual_cash = ?,
        variance = ?,
        status = 'closed',
        is_locked = 1,
        closed_at = CURRENT_TIMESTAMP,
        closed_by_user = ?,
        notes = ?
    WHERE id = ?
  `, [actualCashCounted, variance, closedByUser, notes, closing.id]);

  await db.execute(`
    INSERT INTO audit_logs (user_name, role, action, details)
    VALUES (?, 'admin', 'DAY_CLOSING', ?)
  `, [closedByUser, `Closed day ${dateStr}. Expected: Rs. ${expected}, Actual: Rs. ${actualCashCounted}, Variance: Rs. ${variance}`]);

  return await db.queryOne("SELECT * FROM cash_closings WHERE id = ?", [closing.id]);
}

async function addCashAdjustment(closingId, adjustmentAmount, reason, authorizedBy = 'admin') {
  const closing = await db.queryOne("SELECT * FROM cash_closings WHERE id = ?", [closingId]);
  if (!closing) throw new Error("Closing record not found");

  const currentAdjustments = JSON.parse(closing.adjustments_json || '[]');
  const adjustment = {
    id: currentAdjustments.length + 1,
    amount: adjustmentAmount,
    reason,
    authorizedBy,
    timestamp: getPSTDateString()
  };
  currentAdjustments.push(adjustment);

  const newActual = closing.actual_cash + adjustmentAmount;
  const newVariance = newActual - closing.expected_cash;

  await db.execute(`
    UPDATE cash_closings
    SET actual_cash = ?, variance = ?, adjustments_json = ?
    WHERE id = ?
  `, [newActual, newVariance, JSON.stringify(currentAdjustments), closingId]);

  return { success: true, adjustment, newActual, newVariance };
}

module.exports = {
  hashPassword,
  getPSTDateString,
  getPSTDateOnly,
  generateOrderNumber,
  deductRecipeInventoryForOrder,
  reverseOrderInventoryAndAccounting,
  recordUdhaarSale,
  recordCustomerPayment,
  recordSupplierPurchaseInvoice,
  recordSupplierPayment,
  generateKOTsForOrder,
  getCustomerReceiptData,
  getDailyCashBook,
  closeDailyCashBook,
  addCashAdjustment
};
