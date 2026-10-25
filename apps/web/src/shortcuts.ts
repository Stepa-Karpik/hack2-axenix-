export function isSaveShortcut(
  e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "code" | "key">,
) {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    (e.code === "KeyS" || ["s", "ы"].includes(e.key.toLocaleLowerCase()))
  );
}
