import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IPL Auction & Manager Web Game',
  description: 'Full-Stack Server-Authoritative IPL Auction and Season Manager Simulation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-canvas text-slate-100 min-h-screen flex flex-col font-sans selection:bg-brand-gold/30 selection:text-brand-gold">
        {children}
      </body>
    </html>
  );
}
