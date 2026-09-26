"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { MerchantInvitation, MerchantMember, MerchantMemberChange } from "@gospaza/contracts";
import { AuthError } from "@gospaza/api-client";
import { merchantClient, merchantError } from "../../merchant-client";
import { useMerchant } from "../shell";

interface TeamData {
  members: MerchantMember[];
  invitations: MerchantInvitation[];
}

export default function Team() {
  const { tenant, refresh } = useMerchant();
  const mayView = tenant.membership.capabilities.includes("MERCHANT_TEAM_VIEW");
  const mayManage = tenant.membership.capabilities.includes("MERCHANT_TEAM_MANAGE");
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MANAGER" | "PICKER">("MANAGER");
  const [oneTimeLink, setOneTimeLink] = useState<{ id: string; url: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const lifetime = useRef<{ active: boolean; generation: number } | null>(null);
  const submitting = useRef(false);
  const load = useCallback((): Promise<void> => {
    const scope = lifetime.current;
    if (!scope?.active) return Promise.resolve();
    const generation = ++scope.generation;
    const isCurrent = () => scope.active && generation === scope.generation;
    return Promise.all([merchantClient.members(), merchantClient.invitations()]).then(
      ([members, invitations]) => {
        if (!isCurrent()) return;
        setData({ ...members, ...invitations });
        setError("");
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        setData(null);
        setError(merchantError(error));
        if (error instanceof AuthError && [401, 403].includes(error.status ?? 0)) return refresh();
      },
    );
  }, [refresh]);
  useEffect(() => {
    const scope = { active: mayView, generation: 0 };
    lifetime.current = scope;
    if (mayView) void load();
    return () => { scope.active = false; };
  }, [load, mayView]);

  async function mutate(work: (isActive: () => boolean) => Promise<void>) {
    const scope = lifetime.current;
    if (!scope?.active || submitting.current) return;
    const isActive = () => scope.active;
    // A pre-mutation read must not overwrite the result of this operation.
    scope.generation++;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await work(isActive);
      if (isActive()) await load();
    } catch (error) {
      if (!isActive()) return;
      setError(merchantError(error));
      if (error instanceof AuthError && [401, 403].includes(error.status ?? 0)) {
        setData(null);
        setOneTimeLink(null);
        await refresh();
      }
    } finally {
      submitting.current = false;
      if (isActive()) setBusy(false);
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate(async (isActive) => {
      const result = await merchantClient.invite(email, role);
      if (!isActive()) return;
      setOneTimeLink({ id: result.invitation.id, url: window.location.origin + "/invite#" + result.token });
      setCopyStatus("");
      setEmail("");
    });
  }
  async function copyLink() {
    const scope = lifetime.current;
    if (!scope?.active || !oneTimeLink) return;
    try {
      await navigator.clipboard.writeText(oneTimeLink.url);
      if (scope.active) setCopyStatus("Invitation link copied.");
    } catch {
      if (scope.active) setCopyStatus("Copy the link from the field above.");
    }
  }
  async function revoke(invitation: MerchantInvitation) {
    if (!window.confirm("Revoke the invitation for " + invitation.email + "?")) return;
    await mutate(async (isActive) => {
      await merchantClient.revoke(invitation.id);
      if (isActive() && oneTimeLink?.id === invitation.id) setOneTimeLink(null);
    });
  }
  async function change(member: MerchantMember, input: MerchantMemberChange) {
    if (!window.confirm("Change this member's " + (input.role ? "role to " + input.role : "status to " + input.status) + "?")) return;
    await mutate(async () => { await merchantClient.change(member.id, input); });
  }

  if (!mayView) {
    return (
      <>
        <h1>Team access unavailable</h1>
        <p>Your role does not include team access.</p>
      </>
    );
  }
  return (
    <div className="application-content">
      <h1>Merchant team</h1>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {mayManage && (
        <section aria-labelledby="invite-title">
          <h2 id="invite-title">Invite a teammate</h2>
          <form onSubmit={invite} className="application-fields" aria-busy={busy}>
            <label>
              Invitation email
              <input
                type="email" required maxLength={254} value={email} disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Invitation role
              <select
                value={role} disabled={busy}
                onChange={(event) => {
                  if (event.target.value === "MANAGER" || event.target.value === "PICKER") {
                    setRole(event.target.value);
                  }
                }}
              >
                <option value="MANAGER">MANAGER</option>
                <option value="PICKER">PICKER</option>
              </select>
            </label>
            <div><button type="submit" disabled={busy}>Create invitation</button></div>
          </form>
          <p>Share the link manually with the invited person. No email is sent. Reloading this page removes the link; revoke and reissue it if lost.</p>
          {oneTimeLink && (
            <div className="invite-link">
              <label>
                One-time invitation link
                <input readOnly value={oneTimeLink.url} onFocus={(event) => event.currentTarget.select()} />
              </label>
              <button type="button" onClick={() => void copyLink()}>Copy invitation link</button>
              {copyStatus && <p role="status">{copyStatus}</p>}
            </div>
          )}
        </section>
      )}
      {!data && (error
        ? <button onClick={() => void load()}>Retry team</button>
        : <p role="status">Loading team…</p>)}
      {data && (
        <>
          <section aria-labelledby="members-title">
            <h2 id="members-title">Members</h2>
            {!data.members.length ? <p>No members available.</p> : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Member</th><th>Role</th><th>Status</th>
                      {mayManage && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((member) => (
                      <tr key={member.id}>
                        <td>{member.id}</td><td>{member.role}</td><td>{member.status}</td>
                        {mayManage && (
                          <td>
                            {member.role === "OWNER" ? <span>Owner protected</span> : (
                              <>
                                <button
                                  disabled={busy}
                                  onClick={() => void change(member, { role: member.role === "MANAGER" ? "PICKER" : "MANAGER" })}
                                >
                                  Make {member.role === "MANAGER" ? "PICKER" : "MANAGER"}
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() => void change(member, { status: member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })}
                                >
                                  {member.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                                </button>
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section aria-labelledby="invitations-title">
            <h2 id="invitations-title">Invitations</h2>
            {!data.invitations.length ? <p>No invitations yet.</p> : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th><th>Role</th><th>State</th><th>Expires</th>
                      {mayManage && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td><td>{invitation.role}</td><td>{invitation.state}</td>
                        <td>{new Date(invitation.expires_at).toLocaleString("en-ZA")}</td>
                        {mayManage && (
                          <td>
                            {invitation.state === "PENDING" && (
                              <button disabled={busy} onClick={() => void revoke(invitation)}>Revoke</button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
