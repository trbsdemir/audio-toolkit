'use strict';

import {
  NativeModules,
  DeviceEventEmitter,
  NativeAppEventEmitter,
  Platform,
  EmitterSubscription
} from 'react-native';
import EventEmitter from 'eventemitter3';
import MediaStates from './MediaStates';

// Only import specific items from lodash to keep build size down
import noop from 'lodash/noop';

// Add type declarations for RCTAudioRecorder
interface RCTAudioRecorderInterface {
  prepare: (recorderId: number, path: string, options: RecorderOptions) => Promise<string>;
  record: (recorderId: number) => Promise<void>;
  stop: (recorderId: number) => Promise<void>;
  pause: (recorderId: number) => Promise<void>;
}

const RCTAudioRecorder = Platform.OS === 'ios' ? NativeModules.AudioRecorder : NativeModules.RCTAudioRecorder;

let recorderId = 0;

export interface RecorderOptions {
  autoDestroy: boolean;
  [key: string]: any;
}

const defaultRecorderOptions: RecorderOptions = {
  autoDestroy: true
};

interface EventPayload {
  event: string;
  data: any;
}

/**
 * Represents a media recorder
 * @constructor
 */
class Recorder extends EventEmitter {
  private _path: string;
  private _options: RecorderOptions;
  private _recorderId: number;
  private _state: number;
  private _duration: number;
  private _position: number;
  private _lastSync: number;
  private _fsPath?: string;
  private _eventSubscription?: EmitterSubscription;

  constructor(path: string, options: RecorderOptions = defaultRecorderOptions) {
    super();

    this._path = path;
    this._options = options;

    this._recorderId = recorderId++;
    this._reset();

    const appEventEmitter = Platform.OS === 'ios' ? NativeAppEventEmitter : DeviceEventEmitter;

    this._eventSubscription = appEventEmitter.addListener(
      'RCTAudioRecorderEvent:' + this._recorderId, 
      (payload: EventPayload) => {
        this._handleEvent(payload.event, payload.data);
      }
    );
  }

  private _reset(): void {
    this._state = MediaStates.IDLE;
    this._duration = -1;
    this._position = -1;
    this._lastSync = -1;
  }

  private _updateState(err: Error | null, state: number): void {
    this._state = err ? MediaStates.ERROR : state;
  }

  private _handleEvent(event: string, data: any): void {
    switch (event) {
      case 'ended':
        this._state = Math.min(this._state, MediaStates.PREPARED);
        break;
      case 'info':
        // TODO
        break;
      case 'error':
        this._reset();
        break;
    }

    this.emit(event, data);
  }

  prepare(callback: (err: Error | null, fsPath?: string) => void = noop): Promise<string> {
    this._updateState(null, MediaStates.PREPARING);

    // Use the native promise directly
    const preparePromise: Promise<string> = RCTAudioRecorder.prepare(this._recorderId, this._path, this._options)
      .then((fsPath: string) => {
        this._fsPath = fsPath;
        this._updateState(null, MediaStates.PREPARED);
        return fsPath;
      })
      .catch((err: Error) => {
        this._updateState(err, MediaStates.ERROR);
        throw err;
      });

    // Support backward compatibility with callback
    if (callback !== noop) {
      preparePromise.then(fsPath => callback(null, fsPath)).catch(err => callback(err));
    }

    return preparePromise;
  }

  record(callback: (err: Error | null) => void = noop): Promise<void> {
    let recordPromise: Promise<void>;

    if (this._state === MediaStates.IDLE) {
      // Chain prepare and record
      recordPromise = this.prepare()
        .then(() => RCTAudioRecorder.record(this._recorderId))
        .then(() => {
          this._updateState(null, MediaStates.RECORDING);
        });
    } else {
      // Just record
      recordPromise = RCTAudioRecorder.record(this._recorderId)
        .then(() => {
          this._updateState(null, MediaStates.RECORDING);
        });
    }

    // Support backward compatibility with callback
    if (callback !== noop) {
      recordPromise.then(() => callback(null)).catch(err => callback(err));
    }

    return recordPromise;
  }

  stop(callback: (err: Error | null) => void = noop): Promise<void> {
    let stopPromise: Promise<void>;

    if (this._state >= MediaStates.RECORDING) {
      stopPromise = RCTAudioRecorder.stop(this._recorderId)
        .then(() => {
          this._updateState(null, MediaStates.DESTROYED);
        });
    } else {
      stopPromise = Promise.resolve();
    }

    // Support backward compatibility with callback
    if (callback !== noop) {
      stopPromise.then(() => callback(null)).catch(err => callback(err));
    }

    return stopPromise;
  }

  pause(callback: (err: Error | null) => void = noop): Promise<void> {
    let pausePromise: Promise<void>;

    if (this._state >= MediaStates.RECORDING) {
      pausePromise = RCTAudioRecorder.pause(this._recorderId)
        .then(() => {
          this._updateState(null, MediaStates.PAUSED);
        });
    } else {
      pausePromise = Promise.resolve();
    }

    // Support backward compatibility with callback
    if (callback !== noop) {
      pausePromise.then(() => callback(null)).catch(err => callback(err));
    }

    return pausePromise;
  }

  toggleRecord(callback: (err: Error | null, wasStopped?: boolean) => void = noop): Promise<boolean> {
    let togglePromise: Promise<boolean>;

    if (this._state === MediaStates.RECORDING) {
      togglePromise = this.stop().then(() => true);
    } else {
      togglePromise = this.record().then(() => false);
    }

    // Support backward compatibility with callback
    if (callback !== noop) {
      togglePromise.then(wasStopped => callback(null, wasStopped))
        .catch(err => callback(err));
    }

    return togglePromise;
  }

  destroy(callback: (err: Error | null) => void = noop): Promise<void> {
    this._reset();

    if (callback !== noop) {
      setTimeout(() => callback(null), 0);
    }

    return Promise.resolve();
  }

  get state(): number { return this._state; }
  get canRecord(): boolean { return this._state >= MediaStates.PREPARED; }
  get canPrepare(): boolean { return this._state === MediaStates.IDLE; }
  get isRecording(): boolean { return this._state === MediaStates.RECORDING; }
  get isPrepared(): boolean { return this._state === MediaStates.PREPARED; }
  get fsPath(): string | undefined { return this._fsPath; }
}

export default Recorder; 