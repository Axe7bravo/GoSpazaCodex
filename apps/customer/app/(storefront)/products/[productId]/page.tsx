import { StorefrontView } from "../../views";
export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <StorefrontView view="product" id={productId} />;
}
