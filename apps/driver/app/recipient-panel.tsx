"use client";
import { useCallback, useEffect, useState } from "react";
import { createRecipientClient } from "@gospaza/api-client";
import type { RecipientObservation } from "@gospaza/contracts";
import { useDriverResource } from "@gospaza/ui/driver-resource";

const client = createRecipientClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/login");
const questions = [
  ["document_viewed", "Acceptable document viewed"],
  ["school_uniform_observed", "School uniform observed"],
  ["recipient_declares_school_going_learner", "Recipient declares they are a school-going learner"],
  ["recipient_appears_intoxicated", "Recipient appears intoxicated"],
  ["recipient_refused_verification", "Recipient refused verification"],
  ["invoice_address_matches", "Delivery address matches the invoice"],
] as const;

function Observations({ revision, busy, submit }: { revision: number; busy: boolean; submit: (input: RecipientObservation) => Promise<void> }) {
  const [dob, setDob] = useState("");
  useEffect(() => {
    const clear = () => { if (document.visibilityState !== "visible") setDob(""); };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
  return <form autoComplete="off" onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const role = form.get("recipient_role"), document = form.get("document_type");
    if (role !== "PURCHASER" && role !== "ALTERNATE_ADULT") return;
    if (document !== "NONE" && document !== "IDENTITY_DOCUMENT" && document !== "DRIVERS_LICENCE" && document !== "PASSPORT") return;
    const input: RecipientObservation = {
      expected_revision: revision, recipient_role: role, document_type: document === "NONE" ? null : document,
      date_of_birth: dob || null, document_viewed: form.get("document_viewed") === "yes",
      school_uniform_observed: form.get("school_uniform_observed") === "yes",
      recipient_declares_school_going_learner: form.get("recipient_declares_school_going_learner") === "yes",
      recipient_appears_intoxicated: form.get("recipient_appears_intoxicated") === "yes",
      recipient_refused_verification: form.get("recipient_refused_verification") === "yes",
      invoice_address_matches: form.get("invoice_address_matches") === "yes",
    };
    setDob("");
    void submit(input);
  }}>
    <p>Verify the person receiving the entire order. Purchaser verification does not verify an alternate recipient.</p>
    <fieldset disabled={busy}><legend>Recipient observations</legend>
      <label>Recipient<select name="recipient_role" required defaultValue=""><option value="" disabled>Choose recipient</option><option value="PURCHASER">Purchaser</option><option value="ALTERNATE_ADULT">Alternate adult</option></select></label>
      <label>Document viewed<select name="document_type" required defaultValue=""><option value="" disabled>Choose document</option><option value="IDENTITY_DOCUMENT">Identity document</option><option value="DRIVERS_LICENCE">Driver’s licence</option><option value="PASSPORT">Passport</option><option value="NONE">No acceptable document</option></select></label>
      <label>Observed date of birth<input type="date" autoComplete="off" value={dob} onChange={event => setDob(event.target.value)} /></label>
      <p>Read the date from the document. Do not photograph it or enter its identity number. The date is cleared after submission.</p>
      {questions.map(([name, label]) => <label key={name}>{label}<select name={name} required defaultValue=""><option value="" disabled>Choose an observation</option><option value="yes">Yes</option><option value="no">No</option></select></label>)}
      <button type="submit">Submit recipient observations</button>
    </fieldset>
  </form>;
}

export default function RecipientPanel({ id, phase, changed }: { id: string; phase: string; changed: () => Promise<unknown> }) {
  const load = useCallback(() => client.read(id), [id]);
  const resource = useDriverResource(load, denied);
  const [document, setDocument] = useState<Awaited<ReturnType<typeof client.document>> | null>(null);
  const [documentError, setDocumentError] = useState(false);
  async function act(write: () => Promise<unknown>) { await resource.mutate(write); await changed(); }
  const state = resource.data;
  return <section aria-label="Restricted delivery"><h3>Restricted delivery</h3>
    <p>Restricted items in this delivery. Do not hand over any part of the order before all backend checks and the handoff code succeed.</p>
    {resource.error && <p role="alert">Recipient information is unavailable. Refresh before continuing.</p>}
    {resource.notice && <p role="status">Review the latest result before another action.</p>}
    <button disabled={resource.busy} onClick={() => void resource.refresh()}>Refresh recipient status</button>
    <button onClick={() => { setDocumentError(false); void client.document(id).then(setDocument, () => { setDocument(null); setDocumentError(true); }); }}>View delivery invoice</button>
    {documentError && <p role="alert">Delivery invoice unavailable.</p>}
    {document && state && !resource.error && <section aria-label="Delivery invoice"><h4>Delivery invoice {document.document.document_number}</h4>
      <p>Order {document.document.order_reference} · {document.document.ordered_at}</p>
      <p>{document.document.seller_name} · Registration {document.document.registration_number} · {document.document.registration_category}</p>
      <p>{Object.values(document.document.premises).filter(Boolean).join(", ")}</p>
      <p>Delivery: {Object.values(document.document.address).filter(Boolean).join(", ")}</p>
      <ul>{document.document.goods.map((line,index) => <li key={index}>{line.description} × {line.quantity}</li>)}</ul>
      <button onClick={() => setDocument(null)}>Close invoice</button>
    </section>}
    {phase === "ARRIVED" && state?.compliance === "REQUIRED" && !state.return_state &&
      <Observations key={id + ":" + state.revision + ":" + resource.busy} revision={state.revision} busy={resource.busy}
        submit={input => act(() => client.verify(id, input))} />}
    {phase === "ARRIVED" && state?.compliance === "SATISFIED" && !state.return_state && <p>Recipient checks satisfied. Continue with the customer handoff code.</p>}
    {state?.return_state && <>
      <p>Do not hand over the order. Return the entire physical order to the original store.</p>
      {state.origin_store && <p>Return destination: {state.origin_store.name} · {Object.values(state.origin_store.address).filter(Boolean).join(", ")}</p>}
      <p>Physical return does not confirm a refund, credit, restock or financial adjustment.</p>
      {state.return_state === "RETURN_REQUIRED" && phase !== "ATTENTION_REQUIRED" && <button disabled={resource.busy} onClick={() => void act(() => client.startReturn(id, state.revision))}>Start return to store</button>}
      {state.return_state === "RETURNING_TO_STORE" && !state.awaiting_store_receipt && phase !== "ATTENTION_REQUIRED" && <button disabled={resource.busy} onClick={() => void act(() => client.returnArrival(id, state.revision))}>Arrived at original store</button>}
      {state.awaiting_store_receipt && <p>Awaiting physical receipt acknowledgement from the store. Your commitment remains recorded.</p>}
      {state.return_state === "RETURNED_TO_STORE" && <p>Returned to store. Physical custody acknowledged.</p>}
    </>}
  </section>;
}
