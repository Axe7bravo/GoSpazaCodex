import Link from "next/link";
export default function Page() {
  return <main><p className="brand">GoSpaza</p><h1>Customer app</h1><p>Your local shopping experience is being prepared.</p>
    <p><Link href="/login">Sign in</Link> · <Link href="/register">Create an account</Link> · <Link href="/account">Your account</Link></p></main>;
}

