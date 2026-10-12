'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, Employee, TravelPolicy } from '@/lib/api';

interface Draft {
  grade: string;
  costCentre: string;
  approverId: string;
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [grades, setGrades] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ grade: '', costCentre: '', approverId: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Employee[]>('/corporate/employees').then(setEmployees).catch((e) => setError(e.message));
    api<TravelPolicy[]>('/corporate/policies')
      .then((p) => setGrades(p.map((x) => x.grade)))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const approvers = employees.filter((e) => e.roles.includes('approver') || e.roles.includes('admin'));

  function edit(e: Employee) {
    setEditing(e.id);
    setDraft({ grade: e.grade ?? grades[0] ?? 'default', costCentre: e.costCentre ?? '', approverId: e.approverId ?? '' });
  }

  async function save(e: Employee) {
    setError(null);
    try {
      await api(`/corporate/employees/${e.id}`, {
        method: 'PUT',
        body: JSON.stringify({ grade: draft.grade, costCentre: draft.costCentre || null, approverId: draft.approverId || null }),
      });
      setNotice(`Updated ${e.name}.`);
      setEditing(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Employees</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Each employee&apos;s grade picks their travel policy; the approver receives their trips for approval.
          </p>
        </div>
      </div>
      {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="alert good" style={{ marginBottom: 12 }}>{notice}</div>}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Grade</th>
              <th>Cost centre</th>
              <th>Approver</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {employees.map((e) =>
              editing === e.id ? (
                <tr key={e.id}>
                  <td>
                    {e.name}
                    <div className="muted small">{e.email}</div>
                  </td>
                  <td>
                    <select value={draft.grade} onChange={(x) => setDraft({ ...draft, grade: x.target.value })}>
                      {Array.from(new Set([...grades, draft.grade])).map((g) => (
                        <option key={g}>{g}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={draft.costCentre} maxLength={40} onChange={(x) => setDraft({ ...draft, costCentre: x.target.value })} />
                  </td>
                  <td>
                    <select value={draft.approverId} onChange={(x) => setDraft({ ...draft, approverId: x.target.value })}>
                      <option value="">No approver</option>
                      {approvers
                        .filter((a) => a.id !== e.id)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn secondary" style={{ height: 30 }} onClick={() => setEditing(null)}>
                      Cancel
                    </button>{' '}
                    <button className="btn" style={{ height: 30 }} onClick={() => save(e)}>
                      Save
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={e.id}>
                  <td>
                    {e.name}
                    <div className="muted small">
                      {e.email} · {e.roles.join(', ')}
                    </div>
                  </td>
                  <td>{e.grade ?? <span className="muted">default</span>}</td>
                  <td>{e.costCentre ?? <span className="muted">—</span>}</td>
                  <td>{e.approverName ?? <span className="muted">None</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn secondary" style={{ height: 30 }} onClick={() => edit(e)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
