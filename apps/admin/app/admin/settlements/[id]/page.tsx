import SettlementConsole from "../settlement-console";
export default async function Page({params}:{params:Promise<{id:string}>}) {const {id}=await params;return <SettlementConsole id={id}/>;}
