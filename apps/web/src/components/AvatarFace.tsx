import { useState, type ReactNode } from 'react';
import { avatarSrc } from '../api';

/**
 * A person's profile picture inside an avatar circle, or `children` (their
 * initials) when there is none or it fails to load. The circle around it
 * keeps its size, colour and title; the picture is decorative.
 */
export function AvatarFace({ avatar, children }: { avatar: string | undefined; children: ReactNode }) {
  const src = avatarSrc(avatar);
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{children}</>;
  return <img className="avatar-img" src={src} alt="" draggable={false} data-testid="avatar-img" onError={() => setFailed(src)} />;
}
