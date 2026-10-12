import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tripwise Partner Portal',
  description: 'Search, book and manage travel for your agency',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
