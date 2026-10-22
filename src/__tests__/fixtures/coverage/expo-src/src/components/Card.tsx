import { Pressable } from 'react-native';
export function Card({ testID }: { testID: string }) {
  return <Pressable testID={testID} onPress={() => undefined} />;
}
