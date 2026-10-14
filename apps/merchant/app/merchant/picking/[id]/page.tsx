import PickingDetail from "../picking-detail";
export default async function PickingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PickingDetail key={id} id={id} />;
}
