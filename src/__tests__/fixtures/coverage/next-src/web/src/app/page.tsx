import Link from 'next/link';
export default function Home() {
  return (
    <main data-testid="home">
      <Link data-testid="home-menu" href="/menu">Menu</Link>
    </main>
  );
}
