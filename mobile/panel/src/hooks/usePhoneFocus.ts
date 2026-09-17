import { create } from "zustand";

interface PhoneFocusState {
  focusKey: string | null;
  setFocusKey: (key: string | null) => void;
}

// Presentation-only state shared by the list, side previews, and overview.
export const usePhoneFocusStore = create<PhoneFocusState>((set) => ({
  focusKey: null,
  setFocusKey: (focusKey) =>
    set((state) => (state.focusKey === focusKey ? state : { focusKey })),
}));
