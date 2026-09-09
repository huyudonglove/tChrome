import { requestJSON } from "./service";

type Ref<T> = { current: T };

// A stop response belongs to the conversation operation that initiated it.
// Switching conversations or accepting another stop invalidates that response.
export async function stopCurrentSession<T>(options: {
  conversationId: string | null;
  submission: Ref<number>;
  switching: Ref<boolean>;
  onStopped: (session: T) => void;
  onError: (error: unknown) => void;
}) {
  const { conversationId, submission, switching, onStopped, onError } = options;
  if (switching.current) return;
  const generation = submission.current;
  const isCurrent = () => !switching.current && submission.current === generation;
  try {
    const stopped = await requestJSON<T>("/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    if (!isCurrent()) return;
    submission.current++;
    onStopped(stopped);
  } catch (error) {
    if (isCurrent()) onError(error);
  }
}

export function shouldSubmitOnEnter(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
}) {
  // Some IMEs report keyCode 229 while isComposing is already false.
  return event.key === "Enter" && !event.shiftKey &&
    !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}
