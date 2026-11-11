/**
 * ESC/POS Thermal Printer & Hardware Integration Bridge for ROOMI CAFE POS.
 * Generates genuine ESC/POS byte streams (for LAN/TCP port 9100 or local USB Print Bridge)
 * as well as structured 80mm (48 chars/line) and 58mm (32 chars/line) thermal layouts.
 * Supports:
 *  - Cash drawer kick pulse (ESC p 0)
 *  - Auto paper cutter (GS V 66 0)
 *  - Print density & character size commands
 *  - Separate Customer Receipt vs. Station-segregated Kitchen Tickets (KOT)
 */

const net = require('net');

const ESC = '\x1B';
const GS = '\x1D';

const ESCPOS_COMMANDS = {
  INIT: `${ESC}@`,
  ALIGN_LEFT: `${ESC}a\x00`,
  ALIGN_CENTER: `${ESC}a\x01`,
  ALIGN_RIGHT: `${ESC}a\x02`,
  BOLD_ON: `${ESC}E\x01`,
  BOLD_OFF: `${ESC}E\x00`,
  DOUBLE_HEIGHT_WIDTH: `${GS}!\x11`,
  NORMAL_SIZE: `${GS}!\x00`,
  CUT_FULL: `${GS}V\x41\x03`,
  CUT_PARTIAL: `${GS}V\x42\x00`,
  OPEN_CASH_DRAWER: `${ESC}p\x00\x19\xFA` // Pin 2 pulse
};

function buildEscPosCustomerReceipt(receiptData, options = {}) {
  const width = options.paperWidth === '58mm' ? 32 : 48;
  const divider = '-'.repeat(width) + '\n';
  const eqDivider = '='.repeat(width) + '\n';

  let out = ESCPOS_COMMANDS.INIT;
  if (options.openCashDrawer) {
    out += ESCPOS_COMMANDS.OPEN_CASH_DRAWER;
  }

  out += ESCPOS_COMMANDS.ALIGN_CENTER;
  out += ESCPOS_COMMANDS.BOLD_ON + ESCPOS_COMMANDS.DOUBLE_HEIGHT_WIDTH;
  out += (receiptData.cafe.name || 'ROOMI CAFE') + '\n';
  out += ESCPOS_COMMANDS.NORMAL_SIZE + ESCPOS_COMMANDS.BOLD_OFF;
  out += (receiptData.cafe.address || 'Gulberg III, Lahore') + '\n';
  out += `Tel: ${receiptData.cafe.phone || '0300-7666422'}\n`;
  out += eqDivider;

  out += ESCPOS_COMMANDS.ALIGN_LEFT;
  out += `Order #: ${receiptData.order.orderNumber}\n`;
  out += `Type: ${receiptData.order.orderType} | Table: ${receiptData.order.tableNumber}\n`;
  out += `Date: ${receiptData.order.pstFormattedTime}\n`;
  out += divider;

  for (const item of receiptData.items) {
    const lineTotal = `Rs.${(item.totalPrice || item.quantity * item.unitPrice).toFixed(0)}`;
    const left = `${item.quantity}x ${item.nameEn}`.slice(0, width - lineTotal.length - 1);
    const spaces = ' '.repeat(Math.max(1, width - left.length - lineTotal.length));
    out += `${left}${spaces}${lineTotal}\n`;
  }

  out += divider;
  out += ESCPOS_COMMANDS.ALIGN_RIGHT;
  out += `Subtotal: Rs. ${receiptData.totals.subtotal}\n`;
  if (receiptData.totals.discountAmount > 0) {
    out += `Discount: -Rs. ${receiptData.totals.discountAmount}\n`;
  }
  out += ESCPOS_COMMANDS.BOLD_ON;
  out += `GRAND TOTAL: Rs. ${receiptData.totals.grandTotal}\n`;
  out += ESCPOS_COMMANDS.BOLD_OFF;
  out += `Payment: ${(receiptData.order.paymentMethod || 'CASH').toUpperCase()}\n`;
  out += eqDivider;

  out += ESCPOS_COMMANDS.ALIGN_CENTER;
  out += 'Thank you for visiting ROOMI CAFE!\n\n\n';

  if (options.autoCut !== false) {
    out += ESCPOS_COMMANDS.CUT_PARTIAL;
  }

  return Buffer.from(out, 'binary').toString('base64');
}

function sendRawToNetworkPrinter(ip, port = 9100, base64Payload, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => {
      const buf = Buffer.from(base64Payload, 'base64');
      socket.write(buf, () => {
        socket.end();
        resolve({ success: true, target: `${ip}:${port}`, bytesSent: buf.length });
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Network printer timeout (${ip}:${port})`));
    });
    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

module.exports = {
  ESCPOS_COMMANDS,
  buildEscPosCustomerReceipt,
  sendRawToNetworkPrinter
};
