//
//  AudioManager.m
//  ReactNativeAudioToolkit
//
//  Created by Oskar Vuola on 28/06/16.
//  Copyright (c) 2016-2019 Futurice.
//  Copyright (c) 2019+ React Native Community.
//
//  Licensed under the MIT license. For more information, see LICENSE.

#import "AudioRecorder.h"
#import "RCTEventDispatcher.h"
//#import "RCTEventEmitter"
#import "Helpers.h"

@import AVFoundation;

@interface AudioRecorder () <AVAudioRecorderDelegate>

@property (nonatomic, strong) NSMutableDictionary *recorderPool;

@end

@implementation AudioRecorder {
    id _meteringUpdateTimer;
    int _meteringFrameId;
    int _meteringUpdateInterval;
    NSNumber *_meteringRecorderId;
    AVAudioRecorder *_meteringRecorder;
    NSDate *_prevMeteringUpdateTime;
}

@synthesize bridge = _bridge;

- (void)dealloc {
    [self stopMeteringTimer];
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    NSError *error = nil;
    [audioSession setActive:NO error:&error];

    if (error) {
        NSLog (@"RCTAudioRecorder: Could not deactivate current audio session. Error: %@", error);
        return;
    }
}

- (NSMutableDictionary *) recorderPool {
    if (!_recorderPool) {
        _recorderPool = [NSMutableDictionary new];
    }
    return _recorderPool;
}

-(NSNumber *) keyForRecorder:(nonnull AVAudioRecorder*)recorder {
    return [[_recorderPool allKeysForObject:recorder] firstObject];
}

#pragma mark - Metering functions

- (void)stopMeteringTimer {
    [_meteringUpdateTimer invalidate];
    _meteringFrameId = 0;
    _prevMeteringUpdateTime = nil;
    _meteringRecorderId = nil;
    _meteringRecorder = nil;
}

- (void)startMeteringTimer:(int)monitorInterval {
    _meteringUpdateInterval = monitorInterval;

    [self stopMeteringTimer];

    _meteringUpdateTimer = [CADisplayLink displayLinkWithTarget:self selector:@selector(sendMeteringUpdate)];
    [_meteringUpdateTimer addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSDefaultRunLoopMode];
}

- (void)sendMeteringUpdate {
    if (!_meteringRecorder) {
        [self stopMeteringTimer];
        return;
    }
    if (!_meteringRecorder.isRecording) {
        return;
    }

    if (_prevMeteringUpdateTime == nil ||
     (([_prevMeteringUpdateTime timeIntervalSinceNow] * -1000.0) >= _meteringUpdateInterval)) {
        _meteringFrameId++;
        NSMutableDictionary *body = [[NSMutableDictionary alloc] init];
        [body setObject:[NSNumber numberWithFloat:_meteringFrameId] forKey:@"id"];

        [_meteringRecorder updateMeters];
        float _currentLevel = [_meteringRecorder averagePowerForChannel: 0];
        [body setObject:[NSNumber numberWithFloat:_currentLevel] forKey:@"value"];
        [body setObject:[NSNumber numberWithFloat:_currentLevel] forKey:@"rawValue"];
        NSString *eventName = [NSString stringWithFormat:@"RCTAudioRecorderEvent:%@", _meteringRecorderId];
        [self.bridge.eventDispatcher sendAppEventWithName:eventName
                                                     body:@{@"event" : @"meter",
                                                            @"data" : body
                                                          }];
        _prevMeteringUpdateTime = [NSDate date];
    }
}

#pragma mark - React exposed functions

RCT_EXPORT_MODULE();


RCT_EXPORT_METHOD(prepare:(nonnull NSNumber *)recorderId
                  withPath:(NSString * _Nullable)filename
                  withOptions:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if ([filename length] == 0) {
        reject(@"invalidpath", @"Provided path was empty", nil);
        return;
    } else if ([[self recorderPool] objectForKey:recorderId]) {
        reject(@"invalidpath", @"Recorder with that id already exists", nil);
        return;
    }

    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *documentsDirectory = [paths objectAtIndex:0];
    NSString *filePath = [documentsDirectory stringByAppendingPathComponent:filename];

    NSURL *url = [NSURL fileURLWithPath:filePath];

    // Initialize audio session
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    NSError *error = nil;
    [audioSession setCategory:AVAudioSessionCategoryRecord withOptions:AVAudioSessionCategoryOptionAllowBluetooth error:&error];
    if (error) {
        reject(@"preparefail", @"Failed to set audio session category", error);
        return;
    }

    // Set audio session active
    [audioSession setActive:YES error:&error];
    if (error) {
        NSString *errMsg = [NSString stringWithFormat:@"Could not set audio session active, error: %@", error];
        reject(@"preparefail", errMsg, error);
        return;
    }

    // Settings for the recorder
    NSDictionary *recordSetting = [Helpers recorderSettingsFromOptions:options];

    // Initialize a new recorder
    AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:url settings:recordSetting error:&error];
    if (error) {
        NSString *errMsg = [NSString stringWithFormat:@"Failed to initialize recorder, error: %@", error];
        reject(@"preparefail", errMsg, error);
        return;

    } else if (!recorder) {
        reject(@"preparefail", @"Failed to initialize recorder", nil);
        return;
    }
    recorder.delegate = self;
    [[self recorderPool] setObject:recorder forKey:recorderId];

    BOOL success = [recorder prepareToRecord];
    if (!success) {
        [self destroyRecorderWithId:recorderId];
        reject(@"preparefail", @"Failed to prepare recorder. Settings are probably wrong.", nil);
        return;
    }

    NSNumber *meteringInterval = [options objectForKey:@"meteringInterval"];
    if (meteringInterval) {
        recorder.meteringEnabled = YES;
        [self startMeteringTimer:[meteringInterval intValue]];
        if (_meteringRecorderId != nil)
            NSLog(@"multiple recorder metering are not currently supporter. Metering will be active on the last recorder.");
        _meteringRecorderId = recorderId;
        _meteringRecorder = recorder;
    }

    resolve(filePath);
}

RCT_EXPORT_METHOD(record:(nonnull NSNumber *)recorderId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    AVAudioRecorder *recorder = [[self recorderPool] objectForKey:recorderId];
    if (recorder) {
        if (![recorder record]) {
            reject(@"startfail", @"Failed to start recorder", nil);
            return;
        }
    } else {
        reject(@"notfound", @"Recorder with that id was not found", nil);
        return;
    }
    resolve(nil);
}

RCT_EXPORT_METHOD(stop:(nonnull NSNumber *)recorderId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    AVAudioRecorder *recorder = [[self recorderPool] objectForKey:recorderId];
    if (recorder) {
        [recorder stop];
    } else {
        reject(@"notfound", @"Recorder with that id was not found", nil);
        return;
    }
    if (recorderId == _meteringRecorderId) {
        [self stopMeteringTimer];
    }
    resolve(nil);
}

RCT_EXPORT_METHOD(pause:(nonnull NSNumber *)recorderId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    AVAudioRecorder *recorder = [[self recorderPool] objectForKey:recorderId];
    if (recorder) {
        [recorder pause];
    } else {
        reject(@"notfound", @"Recorder with that id was not found", nil);
        return;
    }
    resolve(nil);
}

RCT_EXPORT_METHOD(destroy:(nonnull NSNumber *)recorderId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    [self destroyRecorderWithId:recorderId];
    resolve(nil);
}

#pragma mark - Delegate methods
- (void)audioRecorderDidFinishRecording:(AVAudioRecorder *) aRecorder successfully:(BOOL)flag {
    if ([[_recorderPool allValues] containsObject:aRecorder]) {
        NSNumber *recordId = [self keyForRecorder:aRecorder];
        [self destroyRecorderWithId:recordId];
    }
}

- (void)destroyRecorderWithId:(NSNumber *)recorderId {
    if ([[[self recorderPool] allKeys] containsObject:recorderId]) {
        AVAudioRecorder *recorder = [[self recorderPool] objectForKey:recorderId];
        if (recorder) {
            [recorder stop];
            [[self recorderPool] removeObjectForKey:recorderId];
            NSString *eventName = [NSString stringWithFormat:@"RCTAudioRecorderEvent:%@", recorderId];
            [self.bridge.eventDispatcher sendAppEventWithName:eventName
                                                         body:@{@"event" : @"ended",
                                                                @"data" : [NSNull null]
                                                                }];
        }
    }
}

- (void)audioRecorderEncodeErrorDidOccur:(AVAudioRecorder *)recorder
                                   error:(NSError *)error {
    NSNumber *recordId = [self keyForRecorder:recorder];

    [self destroyRecorderWithId:recordId];
    NSString *eventName = [NSString stringWithFormat:@"RCTAudioRecorderEvent:%@", recordId];
    [self.bridge.eventDispatcher sendAppEventWithName:eventName
                                               body:@{@"event": @"error",
                                                      @"data" : [error description]
                                                      }];
}

@end
