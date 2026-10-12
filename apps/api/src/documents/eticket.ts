import PDFDocument from 'pdfkit';

export interface ETicketData {
  reference: string;
  pnr: string;
  issuedBy: string;
  passengers: { title: string; firstName: string; lastName: string }[];
  ticketNumbers: string[];
  slices: {
    segments: {
      marketingCarrier: string;
      flightNumber: string;
      origin: string;
      destination: string;
      departureLocal: string;
      arrivalLocal: string;
    }[];
  }[];
  fareBrand?: string;
  baggage?: string;
  total: string;
}

const INK = '#16202b';
const MUTED = '#7b8794';
const BRAND = '#0f6e6a';

/** Renders an e-ticket receipt as a PDF buffer. Pure function of its input, so it is easy to test. */
export function renderETicket(d: ETicketData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `E-ticket ${d.reference}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor(BRAND).fontSize(22).text('Tripwise', { continued: true }).fillColor(INK).fontSize(14).text('  E-ticket receipt');
    doc.moveDown(0.3).fillColor(MUTED).fontSize(10).text(`Issued by ${d.issuedBy}`);
    doc.moveDown();

    const row = (label: string, value: string) => {
      doc.fillColor(MUTED).fontSize(10).text(label, { continued: true, width: 500 }).fillColor(INK).text(`  ${value}`);
    };
    row('Booking reference', d.reference);
    row('Airline reference (PNR)', d.pnr);
    if (d.fareBrand) row('Fare', d.fareBrand);
    if (d.baggage) row('Baggage', d.baggage);
    doc.moveDown();

    doc.fillColor(INK).fontSize(13).text('Passengers');
    doc.moveDown(0.3).fontSize(10);
    d.passengers.forEach((p, i) => {
      doc.fillColor(INK).text(`${p.title} ${p.firstName} ${p.lastName}`, { continued: true });
      doc.fillColor(MUTED).text(`   Ticket ${d.ticketNumbers[i] ?? '-'}`);
    });
    doc.moveDown();

    doc.fillColor(INK).fontSize(13).text('Flights');
    doc.moveDown(0.3).fontSize(10);
    for (const s of d.slices) {
      for (const g of s.segments) {
        doc
          .fillColor(INK)
          .text(`${g.flightNumber}  ${g.origin} ${g.departureLocal.replace('T', ' ').slice(0, 16)}  ->  ${g.destination} ${g.arrivalLocal.replace('T', ' ').slice(0, 16)}`);
      }
      doc.moveDown(0.3);
    }
    doc.moveDown();
    row('Total paid', d.total);
    doc.moveDown(2);
    doc
      .fillColor(MUTED)
      .fontSize(8)
      .text(
        'Times are local to each airport. Check in online or arrive at least 3 hours before international departures. ' +
          'Travel documents and visas are the passenger’s responsibility.',
      );
    doc.end();
  });
}
