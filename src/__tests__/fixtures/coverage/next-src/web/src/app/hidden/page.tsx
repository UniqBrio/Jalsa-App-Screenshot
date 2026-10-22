export default function Hidden() {
  return <button data-testid="hidden-ping" onClick={() => undefined}>Ping</button>;
}
