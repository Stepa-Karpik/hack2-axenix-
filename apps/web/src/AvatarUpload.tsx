import { useEffect, useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { api } from "./api";
import { accountError, useAccount } from "./Account";
import Avatar from "./Avatar";

export default function AvatarUpload() {
  const { session, refresh } = useAccount();
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setBusy("");
    setError("");
    return () => {
      epoch.current++;
      controller.current?.abort();
    };
  }, [session?.user?.id]);
  async function save(file?: File) {
    if (lock.current || !session?.user) return;
    setError("");
    if (
      file &&
      (!["image/jpeg", "image/png"].includes(file.type) ||
        file.size > 2 * 1024 * 1024)
    ) {
      setError(
        file.size > 2 * 1024 * 1024
          ? "Фото должно быть не больше 2 МБ."
          : "Выберите изображение PNG или JPEG.",
      );
      return;
    }
    const ticket = epoch.current;
    const request = new AbortController();
    controller.current = request;
    lock.current = true;
    setBusy(file ? "upload" : "remove");
    const body = file ? new FormData() : undefined;
    if (file) body!.append("file", file);
    try {
      await api("/profile/avatar", {
        method: file ? "POST" : "DELETE",
        body,
        signal: request.signal,
      });
      if (ticket === epoch.current) await refresh();
    } catch (cause) {
      if (ticket === epoch.current) setError(accountError(cause));
    } finally {
      if (ticket === epoch.current) {
        lock.current = false;
        setBusy("");
      }
    }
  }
  if (!session?.user) return null;
  const user = session.user;
  return (
    <div
      className="avatar-editor"
      data-tour="profile-photo"
      data-assistant-target="profile-photo"
      aria-busy={!!busy}
    >
      <Avatar user={user} className="settings-avatar" />
      <div className="avatar-editor-body">
        <strong>Фото профиля</strong>
        <p>PNG или JPEG, до 2 МБ</p>
        <div className="avatar-editor-actions">
          <button
            type="button"
            data-assistant-target="profile-photo-button"
            disabled={!!busy}
            onClick={() => input.current?.click()}
          >
            <Camera size={15} />
            {busy === "upload"
              ? "Загрузка…"
              : user.avatarUrl
                ? "Изменить фото"
                : "Загрузить фото"}
          </button>
          {user.avatarUrl && (
            <button
              className="avatar-remove"
              type="button"
              disabled={!!busy}
              onClick={() => void save()}
            >
              <Trash2 size={14} />
              {busy === "remove" ? "Удаление…" : "Удалить фото"}
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          aria-label="Выбрать фото профиля"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void save(file);
          }}
        />
        {error && (
          <p className="avatar-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
