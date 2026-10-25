import { useState } from "react";

export default function Avatar({
  user,
  className = "mini-avatar",
}: {
  user: { username: string; displayName: string; avatarUrl?: string | null };
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={className + " account-photo"}>
      {user.avatarUrl && failed !== user.avatarUrl ? (
        <img
          src={user.avatarUrl}
          alt={"Фото профиля " + user.username}
          onError={() => setFailed(user.avatarUrl ?? null)}
        />
      ) : (
        (user.displayName || user.username).slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
