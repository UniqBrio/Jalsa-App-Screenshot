import { Row } from '../../../components/Row';
const dishes = [{ id: 'd1', name: 'Dosa' }];
export default function Menu() {
  return (
    <section>
      <h1 data-testid="menu-title">Menu</h1>
      <button data-testid="menu-add" onClick={() => undefined}>Add</button>
      <button data-testid="menu-delete" onClick={() => undefined}>Delete</button>
      {dishes.map((d) => (
        <button key={d.id} data-testid={`menu-item-${d.id}`} onClick={() => undefined}>{d.name}</button>
      ))}
      <Row testId="menu-row-special" label="Special" />
    </section>
  );
}
