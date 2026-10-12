import CustomerOrderView from "../order-view";
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerOrderView key={id} id={id} />;
}
