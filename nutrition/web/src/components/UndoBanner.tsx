/** Paired with useDeferredDelete - renders only while a deferred delete is pending. */
export default function UndoBanner({
  visible,
  label = "Deleted",
  onUndo,
}: {
  visible: boolean;
  label?: string;
  onUndo: () => void;
}) {
  if (!visible) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-w-md items-center
                 justify-between bg-neutral-100 px-4 py-3 text-sm font-medium text-ink
                 pb-safe"
      role="status"
    >
      <span>{label}</span>
      <button onClick={onUndo} className="min-h-11 px-3 font-semibold underline">
        Undo
      </button>
    </div>
  );
}
