export interface ChaseCameraSettings {
  behind: number;
  height: number;
  lookAhead: number;
  lookHeight: number;
  lateral: number;
}

export interface ChaseCameraPoint {
  x: number;
  y: number;
  z: number;
}

export interface ChaseCameraPose {
  eye: ChaseCameraPoint;
  look: ChaseCameraPoint;
}

interface TrackSample {
  pos: ChaseCameraPoint;
}

/** Resolve the regular behind-the-car camera for either a straight or sampled curved track. */
export function chaseCameraPose(
  car: { x: number; z: number },
  settings: ChaseCameraSettings,
  track?: { sample: (z: number, x: number) => TrackSample },
): ChaseCameraPose {
  const eyeX = car.x * 0.3 + settings.lateral;
  const lookX = car.x * 0.4;
  if (track) {
    const eye = track.sample(car.z - settings.behind, eyeX).pos;
    const look = track.sample(car.z + settings.lookAhead, lookX).pos;
    return {
      eye: { x: eye.x, y: eye.y + settings.height, z: eye.z },
      look: { x: look.x, y: look.y + settings.lookHeight, z: look.z },
    };
  }
  return {
    eye: { x: eyeX, y: settings.height, z: car.z - settings.behind },
    look: { x: lookX, y: settings.lookHeight, z: car.z + settings.lookAhead },
  };
}
