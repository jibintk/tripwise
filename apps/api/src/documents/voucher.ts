import PDFDocument from 'pdfkit';

export interface VoucherData {
  reference: string;
  issuedBy: string;
  supplierReference: string;
  hotelConfirmation?: string;
  hotel: { name: string; city: string; address: string; stars: number };
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: { adults: number; children: number; guest: { title: string; firstName: string; lastName: string } }[];
  roomName: string;
  board: string;
  specialRequests?: string;
  cancellation: string;
  total: string;
}

const BOARD: Record<string, string> = {
  RO: 'Room only',
  BB: 'Bed and breakfast',
  HB: 'Half board',
  FB: 'Full board',
  AI: 'All inclusive',
};

/** Accommodation voucher the guest shows at check-in. */
export function renderHotelVoucher(d: VoucherData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Hotel voucher ${d.reference}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#16202b';
    const muted = '#7b8794';
    doc.fillColor('#0f6e6a').fontSize(22).text('Tripwise', { continued: true }).fillColor(ink).fontSize(14).text('  Hotel voucher');
    doc.moveDown(0.3).fillColor(muted).fontSize(10).text(`Issued by ${d.issuedBy}. Please present this voucher at check-in.`);
    doc.moveDown();

    doc.fillColor(ink).fontSize(15).text(d.hotel.name);
    // The built-in PDF fonts have no star glyph, so stars are written out.
    doc.fillColor(muted).fontSize(10).text(`${d.hotel.stars}-star · ${d.hotel.address}`);
    doc.moveDown();

    const row = (label: string, value: string) =>
      doc.fillColor(muted).fontSize(10).text(label, { continued: true }).fillColor(ink).text(`  ${value}`);
    row('Booking reference', d.reference);
    row('Supplier reference', d.supplierReference);
    if (d.hotelConfirmation) row('Hotel confirmation', d.hotelConfirmation);
    row('Check-in', d.checkIn);
    row('Check-out', d.checkOut);
    row('Nights', String(d.nights));
    row('Room', `${d.roomName}, ${BOARD[d.board] ?? d.board}`);
    doc.moveDown();

    doc.fillColor(ink).fontSize(13).text('Rooms');
    doc.moveDown(0.3).fontSize(10);
    d.rooms.forEach((r, i) => {
      doc
        .fillColor(ink)
        .text(
          `Room ${i + 1}: ${r.guest.title} ${r.guest.firstName} ${r.guest.lastName}, ${r.adults} adult(s)${r.children ? `, ${r.children} child(ren)` : ''}`,
        );
    });
    if (d.specialRequests) {
      doc.moveDown(0.5).fillColor(muted).text(`Special requests (not guaranteed): ${d.specialRequests}`);
    }
    doc.moveDown();
    row('Cancellation', d.cancellation);
    row('Total paid', d.total);
    doc.moveDown(2);
    doc
      .fillColor(muted)
      .fontSize(8)
      .text('Payment has been made to the supplier. Incidentals, city taxes and extras are payable directly at the hotel.');
    doc.end();
  });
}
