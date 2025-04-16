package com.reactnativecommunity.rctaudiotoolkit;

import android.annotation.TargetApi;
import android.media.MediaRecorder;
import android.util.Log;
import android.net.Uri;
import android.webkit.URLUtil;
import android.content.ContextWrapper;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.WritableNativeMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.IOException;
import java.io.File;
import java.lang.Thread;
import java.util.HashMap;
import java.util.Map;
import java.util.Map.Entry;
import java.util.Objects;
import java.util.Timer;
import java.util.TimerTask;

public class AudioRecorderModule extends ReactContextBaseJavaModule implements
        MediaRecorder.OnInfoListener, MediaRecorder.OnErrorListener {
    private static final String LOG_TAG = "AudioRecorderModule";

    Map<Integer, MediaRecorder> recorderPool = new HashMap<>();
    Map<Integer, Boolean> recorderAutoDestroy = new HashMap<>();

    private ReactApplicationContext context;
    private Timer meteringUpdateTimer;
    private int meteringFrameId = 0;
    private Integer meteringRecorderId = null;
    private MediaRecorder meteringRecorder = null;
    private int meteringInterval = 0;

    public AudioRecorderModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.context = reactContext;
    }

    @Override
    public String getName() {
        return "RCTAudioRecorder";
    }

    private void emitEvent(Integer recorderId, String event, WritableMap data) {
        WritableMap payload = new WritableNativeMap();
        payload.putString("event", event);
        payload.putMap("data", data);

        this.context
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("RCTAudioRecorderEvent:" + recorderId, payload);
    }

    private WritableMap errObj(final String code, final String message) {
        WritableMap err = Arguments.createMap();

        String stackTraceString = "";
        try {
            StackTraceElement[] stackTrace = Thread.currentThread().getStackTrace();
            for (StackTraceElement e : stackTrace) {
                stackTraceString += (e != null ? e.toString() : "null") + "\n";
            }
        } catch (Exception e) {
            stackTraceString = "Exception occurred while parsing stack trace";
        }

        err.putString("err", code);
        err.putString("message", message);
        err.putString("stackTrace", stackTraceString);

        Log.e(LOG_TAG, message);
        Log.d(LOG_TAG, stackTraceString);

        return err;
    }

    private int formatFromName(String name) {
        switch (name) {
            case "aac":
                return MediaRecorder.OutputFormat.AAC_ADTS;
            case "mp4":
                return MediaRecorder.OutputFormat.MPEG_4;
            case "webm":
            case "ogg":
                return MediaRecorder.OutputFormat.WEBM;
            case "amr":
                return MediaRecorder.OutputFormat.AMR_WB;
            default:
                Log.e(LOG_TAG, "Format with name " + name + " not found.");
                return MediaRecorder.OutputFormat.DEFAULT;
        }
    }
    private int formatFromPath(String path) {
        String ext = path.substring(path.lastIndexOf('.') + 1);

        return formatFromName(ext);
    }

    private int encoderFromName(String name) {
        switch (name) {
            case "aac-lc":
                return MediaRecorder.AudioEncoder.AAC;
            case "aac":
                return MediaRecorder.AudioEncoder.AAC;
            case "mp4":
                return MediaRecorder.AudioEncoder.HE_AAC;
            case "webm":
            case "ogg":
                return MediaRecorder.AudioEncoder.VORBIS;
            case "amr":
                return MediaRecorder.AudioEncoder.AMR_WB;
            default:
                Log.e(LOG_TAG, "Encoder with name " + name + " not found.");
                return MediaRecorder.AudioEncoder.DEFAULT;
        }
    }
    private int encoderFromPath(String path) {
        String ext = path.substring(path.lastIndexOf('.') + 1);

        return encoderFromName(ext);
    }

    private Uri uriFromPath(String path) {
        Uri uri = null;

        if (URLUtil.isValidUrl(path)) {
            uri = Uri.parse(path);
        } else {
            String extPath = new ContextWrapper(this.context).getFilesDir() + "/" + path;
            //String extPath = Environment.getExternalStorageDirectory() + "/" + path;

            File file = new File(extPath);
            uri = Uri.fromFile(file);
        }

        return uri;
    }

    // metering methods
    private void startMeteringTimer(int monitorInterval) {
        meteringUpdateTimer = new Timer();
        meteringUpdateTimer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                if (meteringRecorderId != null && meteringRecorder != null) {
                    WritableMap body = Arguments.createMap();
                    body.putDouble("id", meteringFrameId++);

                    int amplitude = meteringRecorder.getMaxAmplitude();
                    if (amplitude == 0) {
                        body.putInt("value", -160);
                        body.putInt("rawValue", 0);
                    } else {
                        body.putInt("rawValue", amplitude);
                        body.putInt("value", (int) (20 * Math.log10(((double) amplitude) / 32767d)));
                    }
                    emitEvent(meteringRecorderId, "meter", body);
                }
            }
        }, 0, monitorInterval);
    }

    private void stopMeteringTimer() {
        if (meteringUpdateTimer != null) {
            meteringUpdateTimer.cancel();
            meteringUpdateTimer.purge();
            meteringUpdateTimer = null;
            meteringFrameId = 0;
        }
    }

    @ReactMethod
    public void destroy(Integer recorderId, Promise promise) {
        MediaRecorder recorder = this.recorderPool.get(recorderId);

        if (recorder != null) {
            recorder.release();
            this.recorderPool.remove(recorderId);
            this.recorderAutoDestroy.remove(recorderId);
            if (recorderId == meteringRecorderId) {
                meteringRecorderId = null;
                meteringRecorder = null;
            }

            WritableMap data = new WritableNativeMap();
            data.putString("message", "Destroyed recorder");

            emitEvent(recorderId, "info", data);
        }

        if (promise != null) {
            promise.resolve(null);
        }
    }

    private void destroy(Integer recorderId) {
        this.destroy(recorderId, null);
    }

    @ReactMethod
    public void prepare(Integer recorderId, String path, ReadableMap options, Promise promise) {
        if (path == null || path.isEmpty()) {
            promise.reject("invalidpath", "Provided path was empty");
            return;
        }

        // Release old recorder if exists
        Log.d(LOG_TAG, "Releasing old recorder...");
        destroy(recorderId);

        Uri uri = uriFromPath(path);

        Log.d(LOG_TAG, uri.getPath());

        //MediaRecorder recorder = MediaRecorder.create(this.context, uri, null, attributes);
        MediaRecorder recorder = new MediaRecorder();

        // TODO: allow configuring?
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC);

        int format = formatFromPath(path);
        int encoder = encoderFromPath(path);
        int bitrate = 128000;
        int channels = 2;
        int sampleRate = 44100;

        if (options.hasKey("format")) {
            format = formatFromName(options.getString("format"));
        }
        if (options.hasKey("encoder")) {
            encoder = encoderFromName(options.getString("encoder"));
        }
        if (options.hasKey("bitrate")) {
            bitrate = options.getInt("bitrate");
        }
        if (options.hasKey("channels")) {
            channels = options.getInt("channels");
        }
        if (options.hasKey("sampleRate")) {
            sampleRate = options.getInt("sampleRate");
        }

        recorder.setOutputFormat(format);
        recorder.setAudioEncoder(encoder);
        recorder.setAudioEncodingBitRate(bitrate);
        recorder.setAudioChannels(channels);
        recorder.setAudioSamplingRate(sampleRate);

        recorder.setOutputFile(uri.getPath());

        recorder.setOnErrorListener(this);
        recorder.setOnInfoListener(this);

        // Auto destroy recorder by default
        boolean autoDestroy = true;

        if (options.hasKey("autoDestroy")) {
            autoDestroy = options.getBoolean("autoDestroy");
        }

        // metering
        if (options.hasKey("meteringInterval") && options.getInt("meteringInterval") > 0) {
            meteringInterval = options.getInt("meteringInterval");
        } else {
            meteringInterval = 0;
        }

        this.recorderPool.put(recorderId, recorder);
        this.recorderAutoDestroy.put(recorderId, autoDestroy);

        try {
            recorder.prepare();

            WritableMap result = Arguments.createMap();
            result.putString("format", "" + format);
            result.putString("encoder", "" + encoder);
            result.putInt("bitrate", bitrate);
            result.putInt("channels", channels);
            result.putInt("sampleRate", sampleRate);
            result.putString("path", uri.getPath());

            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("preparefail", e.toString());
        }
    }

    @ReactMethod
    public void record(Integer recorderId, Promise promise) {
        MediaRecorder recorder = this.recorderPool.get(recorderId);
        if (recorder == null) {
            promise.reject("notfound", "recorderId " + recorderId + " not found.");
            return;
        }

        try {
            recorder.start();
            if (meteringInterval > 0) {
                meteringRecorder = recorder;
                meteringRecorderId = recorderId;
                // set timer for metering
                startMeteringTimer(meteringInterval);
            }

            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("startfail", e.toString());
        }
    }

    @ReactMethod
    public void stop(Integer recorderId, Promise promise) {
        MediaRecorder recorder = this.recorderPool.get(recorderId);
        if (recorder == null) {
            promise.reject("notfound", "recorderId " + recorderId + " not found.");
            return;
        }

        try {
            recorder.stop();
            if (recorderId == meteringRecorderId) {
                stopMeteringTimer();
            }

            if (this.recorderAutoDestroy.get(recorderId)) {
                Log.d(LOG_TAG, "Autodestroying recorder...");
                destroy(recorderId);
            }

            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("stopfail", e.toString());
        }
    }

    @ReactMethod
    public void pause(Integer recorderId, Promise promise) {
        if (android.os.Build.VERSION.SDK_INT < 24) {
            promise.reject("notsupported", "Cannot pause recording on Android SDK Version " +  android.os.Build.VERSION.SDK_INT + ". Minimum is 24.");
            return;
        }

        pause24(recorderId, promise);
    }

    @TargetApi(24)
    private void pause24(Integer recorderId, Promise promise) {
        MediaRecorder recorder = this.recorderPool.get(recorderId);
        if (recorder == null) {
            promise.reject("notfound", "recorderId " + recorderId + " not found.");
            return;
        }

        try {
            recorder.pause();
            if (recorderId == meteringRecorderId) {
                stopMeteringTimer();
            }

            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("pausefail", e.toString());
        }
    }

    // Find recorderId matching recorder from recorderPool
    private Integer getRecorderId(MediaRecorder recorder) {
        for (Entry<Integer, MediaRecorder> entry : recorderPool.entrySet()) {
            if (Objects.equals(recorder, entry.getValue())) {
                return entry.getKey();
            }
        }

        return null;
    }

    @Override
    public void onError(MediaRecorder recorder, int what, int extra) {
        Integer recorderId = getRecorderId(recorder);

        // TODO: translate these codes into english
        WritableMap err = new WritableNativeMap();
        err.putInt("what", what);
        err.putInt("extra", extra);

        WritableMap data = new WritableNativeMap();
        data.putMap("err", err);
        data.putString("message", "Android MediaRecorder error");

        emitEvent(recorderId, "error", data);

        destroy(recorderId);
    }

    @Override
    public void onInfo(MediaRecorder recorder, int what, int extra) {
        Integer recorderId = getRecorderId(recorder);

        // TODO: translate these codes into english
        WritableMap info = new WritableNativeMap();
        info.putInt("what", what);
        info.putInt("extra", extra);

        WritableMap data = new WritableNativeMap();
        data.putMap("info", info);
        data.putString("message", "Android MediaRecorder info");

        emitEvent(recorderId, "info", data);
    }
}
