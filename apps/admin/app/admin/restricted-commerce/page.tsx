"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { AlcoholClass, RestrictedRegistrationDecision, RestrictedTradingPolicy } from "@gospaza/contracts";
import { createRestrictedCommerceClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
const client=createRestrictedCommerceClient(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/login");
const groups=["regulatory_sale_windows","licence_sale_windows","store_sale_windows","dispatch_windows","handoff_windows"] as const;
const labels={regulatory_sale_windows:"Regulatory sale",licence_sale_windows:"Licence sale",store_sale_windows:"Store sale",dispatch_windows:"Dispatch",handoff_windows:"Handoff"};
function Windows({name}:{name:typeof groups[number]}) {
  const [rows,setRows]=useState<number[]>([]);const [next,setNext]=useState(0);
  return <fieldset><legend>{labels[name]} windows · South African time</legend>
    <p>No windows means unresolved and unavailable for this stage. Sale approval requires all three sale schedules.</p>
    {rows.map(index=><div key={index}><input type="hidden" name={name} value={index} />
      <label>Day<select name={name+index+"day"}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,i)=><option key={day} value={i}>{day}</option>)}</select></label>
      <label>Start<input type="time" name={name+index+"start"} required /></label><label>End<input type="time" name={name+index+"end"} required /></label>
      <button type="button" onClick={()=>setRows(rows.filter(row=>row!==index))}>Remove {labels[name]} window</button>
    </div>)}
    <button type="button" disabled={rows.length>=28} onClick={()=>{setRows([...rows,next]);setNext(next+1);}}>Add {labels[name]} window</button>
  </fieldset>;
}
function ProductReview({store,product}:{store:string;product:string}) {
  const load=useCallback(()=>client.adminClassification(store,product),[store,product]);const resource=useDriverResource(load,denied);
  const [alcohol,setAlcohol]=useState(false);
  return <section><h3>Product classification review</h3>
    {resource.error && <p role="alert">Product review unavailable for this store.</p>}
    <button onClick={()=>void resource.refresh()}>Refresh product review</button>
    {resource.data && <>{resource.data.product && <><h4>{resource.data.product.title}</h4><p>{resource.data.product.description}</p><ul>{resource.data.product.variants.map((variant,index)=><li key={index}>{variant.title} · {variant.sku}</li>)}</ul></>}<p>Merchant proposal: {resource.data.proposed}</p><p>Reviewed classification: {resource.data.review?.restriction??"Not reviewed"} · {resource.data.review?.current?"Current":"Review required"}</p>
      <form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);const value=form.get("class");
        const category:AlcoholClass|null=value==="WINE"||value==="BEER"||value==="SPIRITS"||value==="OTHER"?value:null;
        void resource.mutate(()=>client.reviewClassification(store,product,{restriction:alcohol?"ALCOHOL":"NONE",alcohol_class:alcohol?category:null,
          expected_identity:resource.data!.identity_fingerprint,confirmed:true,reason:String(form.get("reason"))}));
      }}><fieldset disabled={resource.busy}><legend>Review this product only</legend>
        <label>Reviewed restriction<select onChange={event=>setAlcohol(event.target.value==="ALCOHOL")}><option value="NONE">None</option><option value="ALCOHOL">Alcohol</option></select></label>
        {alcohol && <label>Alcohol class<select name="class">{["WINE","BEER","SPIRITS","OTHER"].map(value=><option key={value}>{value}</option>)}</select></label>}
        <label>Review reason<textarea name="reason" required maxLength={500} /></label>
        <label className="driver-check"><input type="checkbox" required />I reviewed the product identity and classification, including any proposed downgrade</label>
        <button>Record platform classification</button>
      </fieldset></form>
      {resource.notice && <p role="status">Review the current classification before another decision.</p>}
    </>}
  </section>;
}
function Review({store,name}:{store:string;name:string}) {
  const load=useCallback(()=>client.adminRegistration(store),[store]);const resource=useDriverResource(load,denied);
  const [action,setAction]=useState<RestrictedRegistrationDecision["action"]>("request-changes");
  const [product,setProduct]=useState("");const [formError,setFormError]=useState("");
  const row=resource.data?.registration;
  return <section><h2>Store review: {name}</h2><p>Decisions apply only to this physical store, not every store owned by a merchant.</p>
    {resource.error && <p role="alert">Store review unavailable.</p>}
    <button onClick={()=>void resource.refresh()}>Refresh store review</button>
    {resource.data && <>
      {resource.data.premises && <p>Premises: {Object.values(resource.data.premises).filter(Boolean).join(", ")}</p>}
      <p>Status: {row?.status.replaceAll("_"," ")??"Not submitted"}</p>
      {row && <><p>Registration: {(row.pending_submission??row.submission).registration_number} · {(row.pending_submission??row.submission).category}</p>
        <p>Issuing authority: {(row.pending_submission??row.submission).issuing_authority}</p>
        <p>Valid from {(row.pending_submission??row.submission).valid_from??"Not specified"} until {(row.pending_submission??row.submission).valid_until??"Not specified"}</p>
        {row.pending_submission && <p>Replacement submission awaits review.</p>}
      </>}
      {resource.data.review_note && <p>Last review: {resource.data.review_note}</p>}
      <ul>{resource.data.evidence.map(file=><li key={file.id}><a href={client.evidenceUrl(file.id,store)} target="_blank" rel="noreferrer">Private evidence: {file.display_name}</a></li>)}</ul>
      {row && <form key={row.revision} onSubmit={event=>{
        event.preventDefault();setFormError("");const form=new FormData(event.currentTarget);
        const common={expected_revision:row.revision,confirmed:true as const,reason:String(form.get("reason"))};
        if(action!=="approve") {void resource.mutate(()=>client.review(store,{...common,action}));return;}
        const minutes=(value:FormDataEntryValue|null):number|null=>{
          if(typeof value!=="string"||!/^\d{2}:\d{2}$/.test(value))return null;
          const hour=Number(value.slice(0,2)),minute=Number(value.slice(3,5));
          if(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)return null;
          return hour*60+minute;
        };
        const windowList=(group:typeof groups[number])=>{
          const windows:RestrictedTradingPolicy["store_sale_windows"]=[];
          for(const index of form.getAll(group)){
            const start=minutes(form.get(group+index+"start")),end=minutes(form.get(group+index+"end"));
            if(start===null||end===null)return null;
            windows.push({day:Number(form.get(group+index+"day")),start_minute:start,end_minute:end});
          }
          return windows;
        };
        const classes=form.getAll("class").filter((value):value is AlcoholClass=>value==="WINE"||value==="BEER"||value==="SPIRITS"||value==="OTHER");
        const regulatory=windowList(groups[0]),licence=windowList(groups[1]),sale=windowList(groups[2]),dispatch=windowList(groups[3]),handoff=windowList(groups[4]);
        if(regulatory===null||licence===null||sale===null||dispatch===null||handoff===null){setFormError("Enter a valid start and end time (HH:mm) for every trading window.");return;}
        if(!classes.length||!regulatory.length||!licence.length||!sale.length) {setFormError("Select permitted classes and enter all three sale schedules.");return;}
        const policy:RestrictedTradingPolicy={timezone:"Africa/Johannesburg",source:String(form.get("source")),version:String(form.get("version")),
          effective_from:new Date(String(form.get("from"))).toISOString(),effective_until:form.get("until")?new Date(String(form.get("until"))).toISOString():null,
          permitted_alcohol_classes:classes,regulatory_sale_windows:regulatory,licence_sale_windows:licence,store_sale_windows:sale,dispatch_windows:dispatch.length?dispatch:null,handoff_windows:handoff.length?handoff:null};
        void resource.mutate(()=>client.review(store,{...common,action:"approve",conditions_confirmed:true,trading_policy:policy}));
      }}><fieldset disabled={resource.busy}><legend>Registration decision</legend>
        <label>Action<select value={action} onChange={event=>{const v=event.target.value;if(v==="approve"||v==="request-changes"||v==="suspend"||v==="reactivate"||v==="revoke")setAction(v);}}>{["request-changes","approve","suspend","reactivate","revoke"].map(value=><option key={value} value={value}>{value.replaceAll("-"," ")}</option>)}</select></label>
        <label>Reason<textarea name="reason" maxLength={500} required /></label>
        {action==="approve" && <><label>Verified policy source<input name="source" maxLength={500} required /></label><label>Policy version<input name="version" maxLength={100} required /></label>
          <label>Effective from (device local time)<input name="from" type="datetime-local" required /></label><label>Effective until (device local time)<input name="until" type="datetime-local" /></label>
          <fieldset><legend>Permitted alcohol classes</legend>{["WINE","BEER","SPIRITS","OTHER"].map(value=><label className="driver-check" key={value}><input name="class" type="checkbox" value={value} />{value}</label>)}</fieldset>
          {groups.map(group=><Windows key={group} name={group} />)}
          <label className="driver-check"><input type="checkbox" required />I verified the registration conditions and stage-specific trading windows for these premises</label>
        </>}
        <label className="driver-check"><input type="checkbox" required />Confirm this store-specific decision</label><button>Submit registration decision</button>
      </fieldset></form>}
      {formError && <p role="alert">{formError}</p>}{resource.notice && <p role="status">Decision response received. Review current status before another action.</p>}
      <form onSubmit={event=>{event.preventDefault();setProduct(String(new FormData(event.currentTarget).get("product")));}}><label>Native product reference<input name="product" required maxLength={100} pattern="[A-Za-z0-9_-]+" /></label><button>Open product review for this store</button></form>
      {product && <ProductReview key={store+product} store={store} product={product} />}
    </>}
  </section>;
}
function Queue({offset,change}:{offset:number;change:(offset:number)=>void}) {
  const load=useCallback(()=>client.queue(offset),[offset]);const resource=useDriverResource(load,denied);
  const [selected,setSelected]=useState<{store_id:string;name:string}|null>(null);
  return <><button onClick={()=>void resource.refresh()}>Refresh review queue</button>{resource.error && <p role="alert">Compliance review access unavailable.</p>}
    {resource.data && <><ul>{resource.data.items.map(store=><li key={store.store_id}><button onClick={()=>setSelected(store)}>{store.name}</button> · {store.status}</li>)}</ul>
      {!resource.data.items.length && <p>No stores in this review page.</p>}
      <button disabled={!offset} onClick={()=>change(offset-20)}>Previous stores</button><button disabled={!resource.data.more} onClick={()=>change(offset+20)}>Next stores</button>
      {selected && <Review key={selected.store_id} store={selected.store_id} name={selected.name} />}
    </>}
  </>;
}
export default function ComplianceReview() {const [offset,setOffset]=useState(0);return <main className="driver-workspace"><Link href="/">Admin home</Link><h1>Store alcohol compliance</h1><Queue key={offset} offset={offset} change={setOffset} /></main>;}
