/**
 * Double-Entry Accounting & Financial Summary Service for ROOMI CAFE POS.
 * Guarantees that Total Debits === Total Credits on every transaction.
 * Accounts:
 *  1010: Cash in Hand (Asset)
 *  1020: Bank Account (Asset)
 *  1030: Easypaisa Wallet (Asset)
 *  1040: JazzCash Wallet (Asset)
 *  1100: Customer Receivables / Udhaar (Asset)
 *  1200: Inventory Asset (Asset)
 *  2010: Supplier Payables (Liability)
 *  3010: Owner Investment / Capital (Equity)
 *  3020: Owner Withdrawals / Drawings (Equity)
 *  4010: Sales Revenue (Revenue)
 *  5010: Purchase / COGS Expense (Expense)
 *  5020: Operating Expenses (Expense)
 */

const db = require('./db');

const ACCOUNT_MAP = {
  cash: { code: '1010', name: 'Cash in Hand' },
  bank: { code: '1020', name: 'Bank Account' },
  easypaisa: { code: '1030', name: 'Easypaisa Wallet' },
  jazzcash: { code: '1040', name: 'JazzCash Wallet' },
  udhaar: { code: '1100', name: 'Customer Receivables (Udhaar)' },
  credit: { code: '2010', name: 'Supplier Payables' },
  inventory: { code: '1200', name: 'Inventory Asset' },
  supplier_payable: { code: '2010', name: 'Supplier Payables' },
  owner_investment: { code: '3010', name: 'Owner Investment (Capital)' },
  owner_withdrawal: { code: '3020', name: 'Owner Withdrawals (Drawings)' },
  sales_revenue: { code: '4010', name: 'Sales Revenue' },
  cogs: { code: '5010', name: 'Purchase / COGS Expense' },
  operating_expense: { code: '5020', name: 'Operating Expenses' }
};

async function postJournalEntry({
  description,
  debitCode,
  creditCode,
  amount,
  paymentMethod = 'cash',
  referenceNo = '',
  relatedOrderId = null,
  relatedInvoiceId = null,
  enteredBy = 'admin'
}) {
  if (!amount || amount <= 0) return null;

  const debitAcc = await db.queryOne("SELECT code, name_en FROM chart_of_accounts WHERE code = ?", [debitCode]);
  const creditAcc = await db.queryOne("SELECT code, name_en FROM chart_of_accounts WHERE code = ?", [creditCode]);
  if (!debitAcc || !creditAcc) {
    throw new Error(`Invalid account codes: Dr ${debitCode} / Cr ${creditCode}`);
  }

  const voucherNo = `JV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-5)}`;

  await db.transaction([
    {
      sql: `INSERT INTO accounting_journal (
              voucher_no, description, debit_account_code, debit_account_name,
              credit_account_code, credit_account_name, amount, payment_method,
              reference_no, related_order_id, related_invoice_id, entered_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        voucherNo, description, debitAcc.code, debitAcc.name_en,
        creditAcc.code, creditAcc.name_en, amount, paymentMethod,
        referenceNo, relatedOrderId, relatedInvoiceId, enteredBy
      ]
    },
    {
      sql: "UPDATE chart_of_accounts SET current_debit = current_debit + ? WHERE code = ?",
      params: [amount, debitAcc.code]
    },
    {
      sql: "UPDATE chart_of_accounts SET current_credit = current_credit + ? WHERE code = ?",
      params: [amount, creditAcc.code]
    }
  ]);

  return voucherNo;
}

async function getTrialBalance() {
  const accounts = await db.query("SELECT * FROM chart_of_accounts ORDER BY code ASC");
  let totalDebit = 0;
  let totalCredit = 0;
  const rows = accounts.map(acc => {
    totalDebit += acc.current_debit;
    totalCredit += acc.current_credit;
    const netBalance = acc.normal_side === 'DEBIT'
      ? (acc.current_debit - acc.current_credit)
      : (acc.current_credit - acc.current_debit);
    return {
      ...acc,
      netBalance
    };
  });
  return {
    accounts: rows,
    totalDebit: +totalDebit.toFixed(2),
    totalCredit: +totalCredit.toFixed(2),
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01
  };
}

async function getFinancialSummary(startDate, endDate) {
  const tb = await getTrialBalance();
  const journal = await db.query(`
    SELECT * FROM accounting_journal
    WHERE DATE(transaction_date) BETWEEN ? AND ?
    ORDER BY id DESC
  `, [startDate, endDate]);

  // Daily breakdown by classification
  const summary = {
    income: {
      cashSales: 0,
      bankSales: 0,
      easypaisaSales: 0,
      jazzcashSales: 0,
      creditSales: 0,
      customerCollections: 0,
      otherIncome: 0
    },
    outflows: {
      supplierPayments: 0,
      stockPurchases: 0,
      operatingExpenses: 0,
      ownerWithdrawals: 0
    }
  };

  for (const j of journal) {
    if (j.credit_account_code === '4010') {
      if (j.debit_account_code === '1010') summary.income.cashSales += j.amount;
      else if (j.debit_account_code === '1020') summary.income.bankSales += j.amount;
      else if (j.debit_account_code === '1030') summary.income.easypaisaSales += j.amount;
      else if (j.debit_account_code === '1040') summary.income.jazzcashSales += j.amount;
      else if (j.debit_account_code === '1100') summary.income.creditSales += j.amount;
    } else if (j.credit_account_code === '1100') {
      summary.income.customerCollections += j.amount;
    }

    if (j.debit_account_code === '2010') summary.outflows.supplierPayments += j.amount;
    if (j.debit_account_code === '1200') summary.outflows.stockPurchases += j.amount;
    if (j.debit_account_code === '5020') summary.outflows.operatingExpenses += j.amount;
    if (j.debit_account_code === '3020') summary.outflows.ownerWithdrawals += j.amount;
  }

  return {
    trialBalance: tb,
    journal,
    summary
  };
}

module.exports = {
  ACCOUNT_MAP,
  postJournalEntry,
  getTrialBalance,
  getFinancialSummary
};
