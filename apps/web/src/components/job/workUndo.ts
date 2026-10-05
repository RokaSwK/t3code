import { toastManager } from "../ui/toast";

/** The last few Work changes that can be taken back, newest last. Shared by toasts and `z`. */
const undoStack: Array<{ readonly toastId: string; readonly undo: () => void }> = [];
const UNDO_LIMIT = 10;

function takeUndo(toastId: string) {
  const index = undoStack.findIndex((entry) => entry.toastId === toastId);
  if (index === -1) return;
  const [entry] = undoStack.splice(index, 1);
  toastManager.close(toastId);
  entry!.undo();
}

/** Confirms a Work change that hides an item, with a way to take it back. */
export function showWorkUndoToast(title: string, undo: () => void) {
  const id = toastManager.add({
    type: "success",
    title,
    actionProps: {
      children: "Undo",
      onClick: () => takeUndo(id),
    },
    data: { hideCopyButton: true },
  });
  undoStack.push({ toastId: id, undo });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

/** Takes back the most recent Work change; false when there is nothing to undo. */
export function undoLastWorkAction(): boolean {
  const last = undoStack.at(-1);
  if (!last) return false;
  takeUndo(last.toastId);
  return true;
}
