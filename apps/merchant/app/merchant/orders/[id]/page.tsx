import OrderDetail from "../order-detail";
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail key={id} id={id} />;
}
