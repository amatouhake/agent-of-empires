import { useCallback, useState } from "react";
import { loadSidebarProjection, saveSidebarProjection, type SidebarProjection } from "../lib/sidebarProjection";

export function useSidebarProjection(): readonly [SidebarProjection, (projection: SidebarProjection) => void] {
  const [projection, setProjection] = useState<SidebarProjection>(loadSidebarProjection);

  const update = useCallback((next: SidebarProjection) => {
    setProjection(next);
    saveSidebarProjection(next);
  }, []);

  return [projection, update] as const;
}

