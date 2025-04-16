import { NativeModules, DeviceEventEmitter, NativeAppEventEmitter, Platform } from 'react-native';
import EventEmitter from 'eventemitter3';
import MediaStates from './MediaStates';

import filter from 'lodash/filter';
import identity from 'lodash/identity';
import last from 'lodash/last';
import noop from 'lodash/noop';

const RCTAudioPlayer = NativeModules.RCTAudioPlayer;
let playerId = 0;

export enum PlaybackCategories {
  Playback = 1,
  Ambient = 2,
  SoloAmbient = 3,
}

export interface PlayerOptions {
  autoDestroy: boolean;
  continuesToPlayInBackground: boolean;
  category: PlaybackCategories;
  mixWithOthers: boolean;
}

interface PlayerInfo {
  duration: number;
  position: number;
}

interface PlayerEventData {
  event: string;
  data: any;
}

interface SetOptions {
  volume?: number;
  pan?: number;
  wakeLock?: boolean;
  looping?: boolean;
  speed?: number;
}

const defaultPlayerOptions: PlayerOptions = {
  autoDestroy: true,
  continuesToPlayInBackground: false,
  category: PlaybackCategories.Playback,
  mixWithOthers: false,
};

/**
 * Represents a media player
 * @constructor
 */
class Player extends EventEmitter {
  private _path: string;
  private _options: PlayerOptions;
  private _playerId: number;
  private _state: number;
  private _volume: number;
  private _pan: number;
  private _speed: number;
  private _wakeLock: boolean;
  private _duration: number;
  private _position: number;
  private _lastSync: number;
  private _looping: boolean;
  private _preSeekState?: number;

  constructor(path: string, options: Partial<PlayerOptions> = defaultPlayerOptions) {
    super();

    this._path = path;

    if (options == null) {
      this._options = defaultPlayerOptions;
    } else {
      // Make sure all required options have values
      this._options = {
        autoDestroy: options.autoDestroy ?? defaultPlayerOptions.autoDestroy,
        continuesToPlayInBackground: options.continuesToPlayInBackground ?? defaultPlayerOptions.continuesToPlayInBackground,
        category: options.category ?? defaultPlayerOptions.category,
        mixWithOthers: options.mixWithOthers ?? defaultPlayerOptions.mixWithOthers,
      };
    }

    this._playerId = playerId++;
    this._reset();

    const appEventEmitter = Platform.OS === 'ios' ? NativeAppEventEmitter : DeviceEventEmitter;

    appEventEmitter.addListener(`RCTAudioPlayerEvent:${this._playerId}`, (payload: PlayerEventData) => {
      this._handleEvent(payload.event, payload.data);
    });
  }

  private _reset(): void {
    this._state = MediaStates.IDLE;
    this._volume = 1.0;
    this._pan = 0.0;
    this._speed = 1.0;
    this._wakeLock = false;
    this._duration = -1;
    this._position = -1;
    this._lastSync = -1;
    this._looping = false;
  }

  private _storeInfo(info?: PlayerInfo): void {
    if (!info) {
      return;
    }

    this._duration = info.duration;
    this._position = info.position;
    this._lastSync = Date.now();
  }

  private _updateState(err: Error | null, state: number, results?: any[]): void {
    this._state = err ? MediaStates.ERROR : state;

    if (err || !results) {
      return;
    }

    // Use last truthy value from results array as new media info
    const info = last(filter(results, identity));
    this._storeInfo(info);
  }

  private _handleEvent(event: string, data: any): void {
    // console.log('event: ' + event + ', data: ' + JSON.stringify(data));
    switch (event) {
      case 'progress':
        // TODO
        break;
      case 'ended':
        this._updateState(null, MediaStates.PREPARED);
        this._position = -1;
        break;
      case 'info':
        // TODO
        break;
      case 'error':
        this._state = MediaStates.ERROR;
        // this.emit('error', data);
        break;
      case 'pause':
        this._state = MediaStates.PAUSED;
        this._storeInfo(data.info);
        break;
      case 'forcePause':
        this.pause();
        break;
      case 'looped':
        this._position = 0;
        this._lastSync = Date.now();
        break;
    }

    // Use any type for the emit method to avoid argument count errors
    // EventEmitter from eventemitter3 supports variable argument counts
    (this.emit as any)(event, data);
  }

  async prepare(callback: (err: Error | null) => void = noop): Promise<Player> {
    this._updateState(null, MediaStates.PREPARING);

    try {
      // Prepare player
      const prepareResult = await RCTAudioPlayer.prepare(this._playerId, this._path, this._options);

      // Set initial values for player options
      const setResult = await RCTAudioPlayer.set(
        this._playerId,
        {
          volume: this._volume,
          pan: this._pan,
          wakeLock: this._wakeLock,
          looping: this._looping,
          speed: this._speed,
        }
      );

      const results = [prepareResult, setResult];
      this._updateState(null, MediaStates.PREPARED, results);
      callback(null);
      return this;
    } catch (err) {
      this._updateState(err as Error, MediaStates.IDLE);
      callback(err as Error);
      return this;
    }
  }

  async play(callback: (err: Error | null) => void = noop): Promise<Player> {
    try {
      // Make sure player is prepared
      if (this._state === MediaStates.IDLE) {
        await this.prepare();
      }

      // Start playback
      const playResult = await RCTAudioPlayer.play(this._playerId);

      this._updateState(null, MediaStates.PLAYING, [playResult]);
      callback(null);
      return this;
    } catch (err) {
      this._updateState(err as Error, this._state);
      callback(err as Error);
      return this;
    }
  }

  async pause(callback: (err: Error | null) => void = noop): Promise<Player> {
    try {
      const results = await RCTAudioPlayer.pause(this._playerId);

      // Android emits a pause event on the native side
      if (Platform.OS === 'ios') {
        this._updateState(null, MediaStates.PAUSED, [results]);
      }
      callback(null);
      return this;
    } catch (err) {
      callback(err as Error);
      return this;
    }
  }

  async playPause(callback: (err: Error | null, paused?: boolean) => void = noop): Promise<Player> {
    try {
      if (this._state === MediaStates.PLAYING) {
        await this.pause();
        callback(null, true);
      } else {
        await this.play();
        callback(null, false);
      }
      return this;
    } catch (err) {
      callback(err as Error);
      return this;
    }
  }

  async stop(callback: (err: Error | null) => void = noop): Promise<Player> {
    try {
      const results = await RCTAudioPlayer.stop(this._playerId);

      this._updateState(null, MediaStates.PREPARED);
      this._position = -1;
      callback(null);
      return this;
    } catch (err) {
      callback(err as Error);
      return this;
    }
  }

  async destroy(callback: (err: Error | null) => void = noop): Promise<void> {
    this._reset();
    try {
      await RCTAudioPlayer.destroy(this._playerId);
      callback(null);
    } catch (err) {
      callback(err as Error);
    }
  }

  async seek(position: number = 0, callback: (err: Error | null) => void = noop): Promise<Player> {
    // Store old state, but not if it was already SEEKING
    if (this._state != MediaStates.SEEKING) {
      this._preSeekState = this._state;
    }

    this._updateState(null, MediaStates.SEEKING);

    try {
      const results = await RCTAudioPlayer.seek(this._playerId, position);

      this._updateState(null, this._preSeekState!, [results]);
      callback(null);
    } catch (err) {
      if (err && (err as any).err === 'seekfail') {
        // Seek operation was cancelled; ignore
        return this;
      }

      this._updateState(err as Error, this._preSeekState!);
      callback(err as Error);
    }

    return this;
  }

  private async _setIfInitialized(options: SetOptions, callback: (err: Error | null) => void = noop): Promise<void> {
    if (this._state >= MediaStates.PREPARED) {
      try {
        await RCTAudioPlayer.set(this._playerId, options);
        callback(null);
      } catch (err) {
        callback(err as Error);
      }
    }
  }

  set volume(value: number) {
    this._volume = value;
    this._setIfInitialized({ volume: value });
  }

  set currentTime(value: number) {
    this.seek(value);
  }

  set wakeLock(value: boolean) {
    this._wakeLock = value;
    this._setIfInitialized({ wakeLock: value });
  }

  set looping(value: boolean) {
    this._looping = value;
    this._setIfInitialized({ looping: value });
  }

  set speed(value: number) {
    this._speed = value;
    this._setIfInitialized({ speed: value });
  }

  get currentTime(): number {
    // Queue up an async call to get an accurate current time
    RCTAudioPlayer.getCurrentTime(this._playerId)
      .then(results => {
        this._storeInfo(results);
      })
      .catch(() => {/* Ignore errors */});

    if (this._position < 0) {
      return -1;
    }

    if (this._state === MediaStates.PLAYING) {
      // Estimate the current time based on the latest info we received
      let pos = this._position + (Date.now() - this._lastSync) * this._speed;
      pos = Math.min(pos, this._duration);
      return pos;
    }

    return this._position;
  }

  get volume(): number {
    return this._volume;
  }
  
  get looping(): boolean {
    return this._looping;
  }
  
  get duration(): number {
    return this._duration;
  }
  
  get speed(): number {
    return this._speed;
  }

  get state(): number {
    return this._state;
  }
  
  get canPlay(): boolean {
    return this._state >= MediaStates.PREPARED;
  }
  
  get canStop(): boolean {
    return this._state >= MediaStates.PLAYING;
  }
  
  get canPrepare(): boolean {
    return this._state == MediaStates.IDLE;
  }
  
  get isPlaying(): boolean {
    return this._state == MediaStates.PLAYING;
  }
  
  get isStopped(): boolean {
    return this._state <= MediaStates.PREPARED;
  }
  
  get isPaused(): boolean {
    return this._state == MediaStates.PAUSED;
  }
  
  get isPrepared(): boolean {
    return this._state == MediaStates.PREPARED;
  }
}

export default Player; 