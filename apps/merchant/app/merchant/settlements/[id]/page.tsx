import StatementView from "../statement-view";
export default async function Page({params}:{params:Promise<{id:string}>}) {const {id}=await params;return <StatementView id={id}/>;}
