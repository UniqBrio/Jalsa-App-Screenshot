import { Pressable, Text } from 'react-native';
export default function Course({ id }: { id: string }) {
  return <Pressable testID={`course-member-${id}`} onPress={() => undefined}><Text>Member</Text></Pressable>;
}
