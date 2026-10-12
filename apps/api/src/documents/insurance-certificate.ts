import PDFDocument from 'pdfkit';

export interface CertificateData {
  reference: string;
  issuedBy: string;
  policyNumber: string;
  planName: string;
  region: string;
  startDate: string;
  endDate: string;
  days: number;
  travellers: { title: string; firstName: string; lastName: string; dateOfBirth: string }[];
  coverage: { label: string; limit: string }[];
  total: string;
  emergencyContact: string;
}

/** Certificate of insurance the traveller carries: who is covered, where, when and for what. */
export function renderInsuranceCertificate(d: CertificateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Certificate of insurance ${d.policyNumber}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#16202b';
    const muted = '#7b8794';
    doc.fillColor('#0f6e6a').fontSize(22).text('Tripwise', { continued: true }).fillColor(ink).fontSize(14).text('  Certificate of travel insurance');
    doc.moveDown(0.3).fillColor(muted).fontSize(10).text(`Issued by ${d.issuedBy}. Carry this certificate while travelling.`);
    doc.moveDown();

    const row = (label: string, value: string) =>
      doc.fillColor(muted).fontSize(10).text(label, { continued: true }).fillColor(ink).text(`  ${value}`);
    doc.fillColor(ink).fontSize(15).text(d.planName);
    doc.moveDown(0.5);
    row('Policy number', d.policyNumber);
    row('Booking reference', d.reference);
    row('Area of cover', d.region);
    row('Period of cover', `${d.startDate} to ${d.endDate} (${d.days} days)`);
    row('Premium paid', d.total);
    doc.moveDown();

    doc.fillColor(ink).fontSize(13).text('Insured travellers');
    doc.moveDown(0.3).fontSize(10);
    for (const t of d.travellers) doc.fillColor(ink).text(`${t.title} ${t.firstName} ${t.lastName}, born ${t.dateOfBirth}`);
    doc.moveDown();

    doc.fillColor(ink).fontSize(13).text('Benefits (limits per traveller)');
    doc.moveDown(0.3).fontSize(10);
    for (const c of d.coverage) row(c.label, c.limit);
    doc.moveDown();
    row('24-hour emergency assistance', d.emergencyContact);
    doc.moveDown(2);
    doc
      .fillColor(muted)
      .fontSize(8)
      .text(
        'This certificate summarises the cover. The full policy wording, including exclusions and pre-existing condition terms, applies. ' +
          'Cover can be cancelled for a full refund before the start date.',
      );
    doc.end();
  });
}
