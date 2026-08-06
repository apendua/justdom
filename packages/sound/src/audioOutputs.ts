/**
 * Where the sound comes out.
 *
 * The rest of this package decides what a sound is and where in the room it is
 * heard from; this decides which speakers the room is played through. A desktop
 * headset is rarely the only thing plugged in, and the browser's own choice is
 * not always the one the player is wearing.
 */
import { Observable, distinctUntilChanged, tap } from "rxjs";
import { makeNonReactive, Signal } from "@apendua/signal";

/** One place the browser is willing to send sound to. */
export interface AudioOutput {
  /** What to hand back to `setAudioOutput`. */
  deviceId: string;
  /** What to show the player; never empty. */
  label: string;
}

/**
 * The ids the platform hands out for "whatever the system picked" rather than
 * for a device of its own. They show up alongside the entry for the device they
 * currently point at, which is why they are only kept when nothing else in
 * their group is on offer.
 */
const GENERIC_IDS = new Set(["default", "communications"]);

type RoutableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

/**
 * Whether sound can be pointed at a device of the player's choosing at all.
 * Chromium grew `AudioContext.setSinkId` in 110; Firefox and Safari have not,
 * and there the answer stays no, which is what keeps the whole feature — the
 * device list included — out of sight rather than offering a switch that does
 * nothing.
 */
function canRouteAudio(): boolean {
  if (typeof AudioContext === "undefined") {
    return false;
  }
  const prototype = AudioContext.prototype as RoutableAudioContext;
  return typeof prototype.setSinkId === "function" && !!navigator.mediaDevices?.enumerateDevices;
}

function toAudioOutputs(devices: MediaDeviceInfo[]): AudioOutput[] {
  const byGroup = new Map<string, MediaDeviceInfo>();
  for (const device of devices) {
    if (device.kind !== "audiooutput") {
      continue;
    }
    // One group is one physical output. Chromium lists the same speakers up to
    // three times — once as "default", once as "communications", once under
    // their own name — and counting those as three outputs would put a switch
    // in front of every player with a single pair of speakers.
    const key = device.groupId || device.deviceId;
    const previous = byGroup.get(key);
    if (!previous || GENERIC_IDS.has(previous.deviceId)) {
      // Overwriting keeps the entry's position, so the order the platform
      // reported stays the order the player cycles through.
      byGroup.set(key, device);
    }
  }
  return [...byGroup.values()].map((device, index) => ({
    deviceId: device.deviceId,
    // Labels are only filled in once the page has been granted a media
    // permission, so unnamed outputs still need something to be called.
    label:
      device.label || (GENERIC_IDS.has(device.deviceId) ? "System default" : `Output ${index + 1}`),
  }));
}

function sameOutputs(a: AudioOutput[], b: AudioOutput[]): boolean {
  return (
    a.length === b.length &&
    a.every((output, index) => {
      return output.deviceId === b[index].deviceId && output.label === b[index].label;
    })
  );
}

/**
 * The outputs sound can be sent to, kept up to date as devices are plugged in
 * and pulled out. Emits an empty list first, synchronously, so a caller always
 * has something to render, and stays empty on browsers that cannot route audio
 * anyway.
 */
export function audioOutputs(): Observable<AudioOutput[]> {
  return new Observable<AudioOutput[]>((subscriber) => {
    subscriber.next([]);
    if (!canRouteAudio()) {
      subscriber.complete();
      return;
    }
    const mediaDevices = navigator.mediaDevices;
    let closed = false;
    const refresh = () => {
      mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (!closed) {
            subscriber.next(toAudioOutputs(devices));
          }
        })
        .catch(() => {
          // Enumeration is a courtesy; a browser that refuses simply leaves the
          // player on whatever output it chose for them.
        });
    };
    refresh();
    mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      closed = true;
      mediaDevices.removeEventListener("devicechange", refresh);
    };
  }).pipe(distinctUntilChanged(sameOutputs));
}

/**
 * Points an audio context at one of the outputs from `audioOutputs`. Returns
 * whether it took: nothing here is worth failing a frame over, so an
 * unsupported browser or a device that vanished between listing and choosing
 * both come back as `false`.
 */
export async function setAudioOutput(context: AudioContext, deviceId: string): Promise<boolean> {
  const routable = context as RoutableAudioContext;
  if (typeof routable.setSinkId !== "function") {
    return false;
  }
  try {
    await routable.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}

/** Which output the player picked, and a way to move to the next one. */
export interface AudioOutputSelection {
  /**
   * Everything sound could be sent to. A single entry means there is nothing to
   * choose between, and an empty one that the browser will not say — either way
   * there is no switch worth showing.
   */
  outputs: Signal<AudioOutput[]>;
  /**
   * The chosen output, empty until the player picks one, which leaves the sound
   * wherever the browser put it.
   */
  deviceId: Signal<string>;
  /** Send the sound to one of `outputs`, by id. */
  select: (deviceId: string) => void;
  /**
   * Keeps `outputs` current for as long as it stays subscribed; nothing here
   * updates until it is.
   */
  updates: Observable<AudioOutput[]>;
}

/**
 * Holds an output choice on behalf of a scene: the list to choose from, which
 * one is current, and how to move on. The device list is only refreshed while
 * `updates` is subscribed — pass it to `effectMap` or `use` from wherever the
 * sound is set up.
 */
export function audioOutputSelection(): AudioOutputSelection {
  const outputs = Signal.of<AudioOutput[]>([]);
  const deviceId = Signal.of("");

  // Non-reactive on purpose: this runs inside whichever computation subscribed
  // to `updates`, and reading `deviceId` there would make that computation
  // re-subscribe — re-enumerating the devices — every time the player switches.
  const apply = makeNonReactive((next: AudioOutput[]) => {
    outputs.set(next);
    // An output that was unplugged cannot stay selected; falling back to the
    // empty id hands the choice back to the browser, which is what it does
    // with the stream anyway once the device it was pointed at is gone.
    const current = deviceId.get();
    if (current && !next.some((output) => output.deviceId === current)) {
      deviceId.set("");
    }
  });

  const updates = audioOutputs().pipe(tap(apply));

  return {
    outputs,
    deviceId,
    updates,
    select: (chosen) => {
      // Only somewhere the sound can actually go. A menu built from `outputs`
      // cannot offer anything else, but a device can be pulled out between the
      // menu opening and a row being pressed.
      if (outputs.get().some((output) => output.deviceId === chosen)) {
        deviceId.set(chosen);
      }
    },
  };
}
