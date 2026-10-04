import { toastManager } from "../ui/toast";

/** Confirms a Work change that hides an item, with a way to take it back. */
export function showWorkUndoToast(title: string, undo: () => void) {
  const id = toastManager.add({
    type: "success",
    title,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(id);
        undo();
      },
    },
    data: { hideCopyButton: true },
  });
}
