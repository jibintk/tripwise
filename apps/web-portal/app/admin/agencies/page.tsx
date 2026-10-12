'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, ApiError, session, Tenant } from '@/lib/api';

const CHILD_TYPES: Record<string, string[]> = {
  operator: ['gsa', 'agency', 'corporate'],
  gsa: ['agency'],
  agency: ['sub_agency', 'branch'],
  sub_agency: ['sub_agency', 'branch'],
};
const TYPE_LABEL: Record<string, string> = {
  operator: 'Operator',
  gsa: 'GSA',
  agency: 'Agency',
  sub_agency: 'Sub-agency',
  branch: 'Branch',
  corporate: 'Corporate',
};

interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && Array.isArray(err.body.errors)) {
    return (err.body.errors as { field: string; message: string }[]).map((e) => `${e.field}: ${e.message}`).join('. ');
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export default function AgenciesPage() {
  const me = session.user();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selected, setSelected] = useState<Tenant | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ parentId: '', type: 'agency', name: '', code: '', country: 'KE' });
  const [userForm, setUserForm] = useState({ name: '', email: '', admin: false });

  const load = useCallback(() => {
    api<Tenant[]>('/tenants')
      .then((t) => {
        setTenants(t);
        setForm((f) => ({ ...f, parentId: f.parentId || t[0]?.id || '' }));
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!selected) return;
    api<User[]>(`/tenants/${selected.id}/users`).then(setUsers).catch((e) => setError(errorText(e)));
  }, [selected]);

  const parent = tenants.find((t) => t.id === form.parentId);
  const allowedTypes = parent ? (CHILD_TYPES[parent.type] ?? []) : [];

  async function createTenant(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const t = await api<Tenant>('/tenants', { method: 'POST', body: JSON.stringify(form) });
      setNotice(`${t.name} created. Add its first user below.`);
      setForm({ ...form, name: '', code: '' });
      load();
      setSelected(t);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function toggle(t: Tenant) {
    const status = t.status === 'active' ? 'suspended' : 'active';
    if (status === 'suspended' && !confirm(`Suspend ${t.name}? Its users and everything below it lose access.`)) return;
    try {
      await api(`/tenants/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function createUser(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    try {
      const u = await api<User & { temporaryPassword: string }>(`/tenants/${selected.id}/users`, {
        method: 'POST',
        body: JSON.stringify({
          name: userForm.name,
          email: userForm.email,
          roles: userForm.admin ? ['admin', 'agent'] : ['agent'],
        }),
      });
      setNotice(`User ${u.email} created. Temporary password (shown once): ${u.temporaryPassword}`);
      setUserForm({ name: '', email: '', admin: false });
      setUsers(await api<User[]>(`/tenants/${selected.id}/users`));
    } catch (err) {
      setError(errorText(err));
    }
  }

  const depth = (t: Tenant) => t.path.split('.').length - (tenants[0]?.path.split('.').length ?? 1);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Agencies</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Your network, from {me?.tenant.name} down. Suspending an agency also blocks everything below it.
          </p>
        </div>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="alert good" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="two-col">
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tenants.map((t, i) => (
                <tr key={t.id} style={{ background: selected?.id === t.id ? 'var(--brand-soft)' : undefined }}>
                  <td style={{ paddingLeft: 10 + depth(t) * 20 }}>
                    <a href="#" onClick={(e) => (e.preventDefault(), setSelected(t))}>
                      {t.name}
                    </a>
                    <div className="muted small">{t.code}</div>
                  </td>
                  <td>{TYPE_LABEL[t.type] ?? t.type}</td>
                  <td>
                    <span className={`status ${t.status === 'active' ? 'confirmed' : 'failed'}`}>{t.status}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {i > 0 && (
                      <button className={`btn ${t.status === 'active' ? 'danger' : 'secondary'}`} style={{ height: 30 }} onClick={() => toggle(t)}>
                        {t.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="stack">
          <form className="card stack" onSubmit={createTenant}>
            <h2>Add to the network</h2>
            <div className="field">
              <label>Under</label>
              <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                {tenants
                  .filter((t) => (CHILD_TYPES[t.type] ?? []).length)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Name</label>
              <input
                value={form.name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    name: e.target.value,
                    code: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40),
                  })
                }
                required
              />
            </div>
            <div className="field">
              <label>Code</label>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </div>
            <div className="field">
              <label>Country</label>
              <input value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value })} required />
            </div>
            <button className="btn">Create</button>
          </form>

          {selected && (
            <div className="card stack">
              <h2>Users of {selected.name}</h2>
              {users.length === 0 && <p className="muted small">No users yet.</p>}
              {users.map((u) => (
                <div key={u.id} className="small">
                  <strong>{u.name}</strong> · {u.email}
                  <div className="muted">{u.roles.join(', ')}</div>
                </div>
              ))}
              <form className="stack" onSubmit={createUser}>
                <div className="field">
                  <label>Name</label>
                  <input value={userForm.name} onChange={(e) => setUserForm({ ...userForm, name: e.target.value })} required />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input
                    type="email"
                    value={userForm.email}
                    onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                    required
                  />
                </div>
                <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={userForm.admin} onChange={(e) => setUserForm({ ...userForm, admin: e.target.checked })} />
                  Agency admin (can manage users and markups)
                </label>
                <button className="btn secondary">Add user</button>
              </form>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
