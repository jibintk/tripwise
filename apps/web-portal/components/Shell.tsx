'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, session, SessionUser, Wallet } from '@/lib/api';
import { formatMoney } from '@/lib/format';

/** Fire after anything that moves money, so the header balance updates. */
export const WALLET_CHANGED = 'tripwise:wallet-changed';
export const notifyWalletChanged = () => window.dispatchEvent(new Event(WALLET_CHANGED));

interface NavItem {
  href: string;
  label: string;
  show: (u: SessionUser) => boolean;
}

const isOperator = (u: SessionUser) => u.tenant.type === 'operator';
const can = (u: SessionUser, ...roles: string[]) => roles.some((r) => u.roles.includes(r));

const NAV: NavItem[] = [
  { href: '/search', label: 'Search flights', show: (u) => can(u, 'agent') || isOperator(u) },
  { href: '/bookings', label: 'Bookings', show: () => true },
  { href: '/wallet', label: 'Wallet', show: (u) => !isOperator(u) },
  { href: '/admin/agencies', label: 'Agencies', show: (u) => can(u, 'admin') && u.tenant.type !== 'branch' },
  { href: '/admin/pricing', label: 'Pricing', show: (u) => can(u, 'admin') },
  { href: '/admin/wallets', label: 'Wallets', show: (u) => can(u, 'finance', 'admin') && isOperator(u) },
  { href: '/admin/ops', label: 'Ops queue', show: (u) => can(u, 'ops', 'admin') && isOperator(u) },
];

/** Signed-in frame: top bar, navigation, wallet balance. Redirects to /login without a session. */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);

  useEffect(() => {
    const u = session.user();
    if (!session.token() || !u) {
      router.replace('/login');
      return;
    }
    setUser(u);
    // The operator has no wallet of its own; it sees all wallets under Wallets.
    const refresh = () =>
      isOperator(u) ? Promise.resolve() : api<Wallet>('/accounts/me').then(setWallet).catch(() => setWallet(null));
    refresh();
    window.addEventListener(WALLET_CHANGED, refresh);
    return () => window.removeEventListener(WALLET_CHANGED, refresh);
  }, [router, path]);

  if (!user) return null;

  return (
    <>
      <header className="topbar">
        <Link href="/search" className="brand">
          Trip<span>wise</span>
        </Link>
        <nav className="nav">
          {NAV.filter((n) => n.show(user)).map((n) => (
            <Link key={n.href} href={n.href} className={path?.startsWith(n.href) ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        {wallet && !isOperator(user) && (
          <span className="wallet-pill" title="Balance plus credit line">
            Available {formatMoney({ amount: wallet.available, currency: wallet.currency })}
          </span>
        )}
        <div className="who">
          <strong>{user.name}</strong>
          <br />
          {user.tenant.name}
        </div>
        <button
          className="btn secondary"
          style={{ height: 32 }}
          onClick={() => {
            session.clear();
            router.replace('/login');
          }}
        >
          Sign out
        </button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
