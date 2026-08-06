const LANDSCAPE_REFERENCE_ASPECT = 16 / 9;

type Vector3Tuple = [number, number, number];
export interface FighterCameraShot { pos: Vector3Tuple;lookAt: Vector3Tuple;fov: number; }

export function proceduralFallbackCamera(bounds: [number, number]): FighterCameraShot {
  const center = (bounds[0] + bounds[1]) / 2;
  return { pos: [center, 2.15, 10.5], lookAt: [center, 1.25, 0], fov: 36 };
}

export function shouldUseLivePortraitArena(mapId: string, aspect: number): boolean {
  return mapId === 'inakaya' && Number.isFinite(aspect) && aspect > 0 && aspect < 1;
}

export function portraitOrientationChanged(previousAspect: number, nextAspect: number): boolean {
  if (!Number.isFinite(previousAspect) || previousAspect <= 0 || !Number.isFinite(nextAspect) || nextAspect <= 0) return false;
  return (previousAspect < 1) !== (nextAspect < 1);
}

export function canReloadArenaForViewport(phase: string | undefined, readinessKey: string, readySentFor: string): boolean {
  return phase === 'loading' && readinessKey !== readySentFor;
}

export function responsiveVerticalFov(authoredDegrees: number, aspect: number): number {
  if (!Number.isFinite(authoredDegrees) || authoredDegrees <= 0 || authoredDegrees >= 180) return 36;
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= LANDSCAPE_REFERENCE_ASPECT) return authoredDegrees;
  const authored = authoredDegrees * Math.PI / 180;
  const diagonalScale = Math.sqrt(
    (1 + LANDSCAPE_REFERENCE_ASPECT ** 2) / (1 + aspect ** 2),
  );
  return 2 * Math.atan(Math.tan(authored / 2) * diagonalScale) * 180 / Math.PI;
}

export function frameStaticPortraitArena(
  shot: FighterCameraShot,
  bounds: [number, number],
  fightOrigin: Vector3Tuple,
  rotationYDegrees: number,
  aspect: number,
): FighterCameraShot {
  if (!Number.isFinite(aspect) || aspect >= 1 || aspect <= 0) return shot;
  const angle = rotationYDegrees * Math.PI / 180;
  const midpoint = (bounds[0] + bounds[1]) / 2;
  const target: Vector3Tuple = [
    fightOrigin[0] + Math.cos(angle) * midpoint,
    shot.lookAt[1],
    fightOrigin[2] - Math.sin(angle) * midpoint,
  ];
  const view = [
    shot.pos[0] - shot.lookAt[0],
    shot.pos[1] - shot.lookAt[1],
    shot.pos[2] - shot.lookAt[2],
  ] as Vector3Tuple;
  const viewLength = Math.hypot(...view);
  if (viewLength === 0) return shot;
  const direction = view.map(value => value / viewLength) as Vector3Tuple;
  const currentDepth = direction.reduce((sum, value, index) => sum + value * (shot.pos[index]! - target[index]!), 0);
  const verticalFov = responsiveVerticalFov(shot.fov, aspect) * Math.PI / 180;
  const horizontalTangent = Math.tan(verticalFov / 2) * aspect;
  const requiredDepth = ((bounds[1] - bounds[0]) / 2 + 1.5) / horizontalTangent;
  const distance = Math.max(1, currentDepth, requiredDepth);
  return {
    ...shot,
    pos: target.map((value, index) => value + direction[index]! * distance) as Vector3Tuple,
    lookAt: target,
  };
}
