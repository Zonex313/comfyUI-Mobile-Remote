export const PHONE_CONNECTION_JUMP = "phone-connection-jump";

export interface PhoneConnectionJump {
  itemKey: string;
  nodeId: number;
  direction: "input" | "output";
  flashDomId?: string | null;
  flashDomIds?: string[];
}

/** Returns false when no phone presentation layer accepts this same-scope jump. */
export function requestPhoneConnectionJump(
  detail: PhoneConnectionJump,
): boolean {
  return !window.dispatchEvent(
    new CustomEvent(PHONE_CONNECTION_JUMP, { detail, cancelable: true }),
  );
}
