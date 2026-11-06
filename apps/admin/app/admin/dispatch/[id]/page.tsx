import OperationsConsole from "../../../operations-console";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <OperationsConsole mode="delivery" id={id}/>; }
