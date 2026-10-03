import { StorefrontView } from "../../views";
export default async function Page({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return <StorefrontView view="store" id={storeId} />;
}
