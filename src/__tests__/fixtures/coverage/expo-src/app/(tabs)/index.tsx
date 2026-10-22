import { Pressable, Text } from 'react-native';
import { Card } from '../../src/components/Card';
export default function Home() {
  const action = (testID: string, label: string) => (
    <Pressable testID={testID} onPress={() => undefined}><Text>{label}</Text></Pressable>
  );
  return (
    <>
      {action('home-open', 'Open')}
      <Card testID="home-card" />
      <Text testID="home-title">Home</Text>
    </>
  );
}
