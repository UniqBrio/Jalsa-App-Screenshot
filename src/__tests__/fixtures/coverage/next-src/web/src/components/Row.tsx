export function Row({ testId, label }: { testId: string; label: string }) {
  return <button data-testid={testId}>{label}</button>;
}
