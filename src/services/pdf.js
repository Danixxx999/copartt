'use strict';
// Factura en PDF (entorno de prueba) generada con PDFKit.
const PDFDocument = require('pdfkit');
const db = require('../db');
const { eur } = require('../lib/money');
const settings = require('../lib/settings');

async function invoicePdf(res, invoiceId) {
  const inv = await db.one(`SELECT i.*, u.email, p.first_name, p.last_name, p.company_name, p.address, p.city, p.postal_code, o.order_number
                              FROM invoices i JOIN users u ON u.id=i.user_id JOIN profiles p ON p.user_id=u.id LEFT JOIN sale_orders o ON o.id=i.order_id WHERE i.id=$1`, [invoiceId]);
  const items = await db.many('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [invoiceId]);
  const bank = await settings.get('bank_details', {});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.invoice_number}`, Author: 'copart (academic demo)' } });
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, 70).fill('#0b1a2e');
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('copart', 50, 24);
  doc.fontSize(9).font('Helvetica').text('ACADEMIC DEMO · NOT A VALID TAX INVOICE', 330, 30, { width: 215, align: 'right' });
  doc.fillColor('#111').moveDown(3);
  doc.fontSize(18).font('Helvetica-Bold').text(`Invoice ${inv.invoice_number}`, 50, 95);
  doc.fontSize(10).font('Helvetica').fillColor('#444')
    .text(`Issued: ${new Date(inv.issued_at).toLocaleDateString('en-GB')}   ·   Due: ${new Date(inv.due_at).toLocaleDateString('en-GB')}   ·   Status: ${inv.status.toUpperCase()}`, 50, 120)
    .text(inv.order_number ? `Order: ${inv.order_number}` : `Type: ${inv.kind}`, 50, 135);
  doc.fillColor('#111').font('Helvetica-Bold').text('Bill to', 50, 165).font('Helvetica')
    .text(`${inv.company_name ? inv.company_name + '\n' : ''}${inv.first_name} ${inv.last_name}\n${inv.address || ''} ${inv.postal_code || ''} ${inv.city || ''}\n${inv.email}`, 50, 180);
  doc.font('Helvetica-Bold').text('Issuer', 330, 165).font('Helvetica').text('copart Demo S.L. (fictitious)\nCalle Ficticia 1, 28000 Madrid\nTax ID B00000000 (demo)', 330, 180);
  let y = 260;
  doc.rect(50, y, 495, 22).fill('#e8eefb'); doc.fillColor('#111').font('Helvetica-Bold').fontSize(10);
  doc.text('Description', 58, y + 6).text('Net', 330, y + 6, { width: 60, align: 'right' }).text('VAT', 400, y + 6, { width: 50, align: 'right' }).text('Total', 460, y + 6, { width: 80, align: 'right' });
  y += 30; doc.font('Helvetica');
  for (const i of items) {
    doc.text(i.description, 58, y, { width: 260 }).text(eur(i.amount_cents), 310, y, { width: 80, align: 'right' }).text(`${Number(i.tax_rate)}%`, 400, y, { width: 50, align: 'right' }).text(eur(i.amount_cents + i.tax_cents), 450, y, { width: 90, align: 'right' });
    y += 24; doc.moveTo(50, y - 6).lineTo(545, y - 6).strokeColor('#ddd').stroke();
  }
  y += 6; doc.font('Helvetica');
  const row = (label, val, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 330, y, { width: 120, align: 'right' }).text(val, 450, y, { width: 90, align: 'right' }); y += 18; };
  row('Subtotal', eur(inv.subtotal_cents)); row('VAT', eur(inv.tax_cents)); row('Total', eur(inv.total_cents), true); row('Paid', eur(inv.paid_cents)); row('Balance due', eur(inv.total_cents - inv.paid_cents), true);
  y += 20;
  doc.font('Helvetica-Bold').text('Payment instructions (fictitious)', 50, y); y += 16;
  doc.font('Helvetica').fontSize(9).text(`Vehicle amounts: bank transfer only to ${bank.beneficiary} · IBAN ${bank.iban} · BIC ${bank.bic}. Reference: ${inv.invoice_number}.\nFees may be paid by card in the sandbox. No real payments are processed in this academic environment.`, 50, y, { width: 495 });
  doc.fontSize(8).fillColor('#888').text('Unofficial academic project. Not affiliated with Copart. Amounts and fees are demo values, not real tariffs.', 50, 780, { width: 495, align: 'center' });
  doc.end();
}
module.exports = { invoicePdf };
