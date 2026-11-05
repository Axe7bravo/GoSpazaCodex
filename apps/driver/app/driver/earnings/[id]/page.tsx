"use client";
import { useParams } from "next/navigation";
import { EarningDetail } from "../../../earnings-view";
export default function Page() { const { id } = useParams<{ id: string }>(); return <EarningDetail id={id}/>; }
